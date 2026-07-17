const express = require('express');
const fs = require('fs');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-5.5',        // OpenAI（デフォルト）
    gemini: 'gemini-3.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

const PROMPT_FILES = {
    default: 'prompt.md',
    internships: 'prompts/internships.md',
    brushup: 'prompts/Brushup.md',
};

const PROMPT_TEMPLATES = {};

try {
    Object.values(PROMPT_FILES).forEach((filePath) => {
        fs.accessSync(filePath, fs.constants.R_OK);
    });
    Object.entries(PROMPT_FILES).forEach(([key, filePath]) => {
        PROMPT_TEMPLATES[key] = fs.readFileSync(filePath, 'utf8');
    });
} catch (error) {
    console.error('Error reading prompt file:', error);
    process.exit(1);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const responseCache = new Map();

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', promptKey = 'default', ...variables } = req.body;

        if (!Object.prototype.hasOwnProperty.call(PROMPT_FILES, promptKey)) {
            return res.status(400).json({ error: 'Invalid promptKey' });
        }

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const promptTemplate = PROMPT_TEMPLATES[promptKey];
        const finalPrompt = fillTemplate(promptTemplate, variables);
        const cacheKey = buildCacheKey(promptKey, variables);
        const cachedResult = getCachedResult(cacheKey);
        if (cachedResult) {
            return res.json({
                title: title,
                data: cachedResult,
                cached: true,
            });
        }

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt, promptKey);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        setCachedResult(cacheKey, result);
        res.json({
            title: title,
            data: result,
            cached: false,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate content. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

function buildCacheKey(promptKey, variables) {
    const sortedVariables = Object.keys(variables)
        .sort()
        .reduce((acc, key) => {
            acc[key] = variables[key];
            return acc;
        }, {});
    return JSON.stringify({ promptKey, variables: sortedVariables });
}

function getCachedResult(cacheKey) {
    const entry = responseCache.get(cacheKey);
    if (!entry) {
        return null;
    }
    if (Date.now() - entry.createdAt > RESPONSE_CACHE_TTL_MS) {
        responseCache.delete(cacheKey);
        return null;
    }
    return cloneJson(entry.data);
}

function setCachedResult(cacheKey, data) {
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
    }
    responseCache.set(cacheKey, {
        createdAt: Date.now(),
        data: cloneJson(data),
    });
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function getOpenAIMaxCompletionTokens(promptKey, prompt) {
    if (promptKey === 'brushup') {
        return 6500;
    }
    if (promptKey !== 'internships') {
        return 2000;
    }

    const countMatch = prompt.match(/推薦件数:\s*(\d+)件/);
    const count = countMatch ? Number(countMatch[1]) : 6;
    return Math.min(4200, Math.max(1800, 900 + (count * 260)));
}

async function callOpenAI(prompt, promptKey = 'default') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: getOpenAIMaxCompletionTokens(promptKey, prompt),
            response_format: getOpenAIResponseFormat(promptKey)
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
        throw new Error('OpenAI response did not include choices.');
    }
    if (choice.finish_reason === 'length') {
        throw new Error('OpenAI response was truncated. Reduce count or increase max_completion_tokens.');
    }
    if (choice.finish_reason === 'content_filter') {
        throw new Error('OpenAI response was blocked by the content filter.');
    }
    if (choice.message?.refusal) {
        throw new Error(`OpenAI refused the request: ${choice.message.refusal}`);
    }

    const responseText = choice.message?.content;
    if (!responseText) {
        throw new Error('OpenAI response did not include message content.');
    }
    return extractArray(responseText);
}

function getOpenAIResponseFormat(promptKey) {
    if (promptKey === 'brushup') {
        return {
            type: "json_schema",
            json_schema: {
                name: "idea_brushup_analysis",
                strict: true,
                schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["data"],
                    properties: {
                        data: {
                            type: "array",
                            minItems: 1,
                            maxItems: 1,
                            items: {
                                type: "object",
                                additionalProperties: false,
                                required: ["summary", "assumptions", "similarCases", "evaluations", "personas", "audienceGap", "strengths", "weaknesses", "differentiators", "improvements", "validationPlan", "questions"],
                                properties: {
                                    summary: { type: "string" },
                                    assumptions: { type: "array", items: { type: "string" } },
                                    similarCases: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            additionalProperties: false,
                                            required: ["name", "overview", "similarity", "difference", "certainty"],
                                            properties: {
                                                name: { type: "string" }, overview: { type: "string" },
                                                similarity: { type: "string" }, difference: { type: "string" },
                                                certainty: { type: "string", enum: ["確認済み", "一般知識", "要確認"] }
                                            }
                                        }
                                    },
                                    evaluations: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            additionalProperties: false,
                                            required: ["perspective", "score", "rationale", "comparison"],
                                            properties: {
                                                perspective: { type: "string" }, score: { type: "integer", minimum: 1, maximum: 5 },
                                                rationale: { type: "string" }, comparison: { type: "string" }
                                            }
                                        }
                                    },
                                    personas: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            additionalProperties: false,
                                            required: ["profile", "benefit", "barrier", "interest", "improvement"],
                                            properties: {
                                                profile: { type: "string" }, benefit: { type: "string" }, barrier: { type: "string" },
                                                interest: { type: "string" }, improvement: { type: "string" }
                                            }
                                        }
                                    },
                                    audienceGap: {
                                        type: "object", additionalProperties: false,
                                        required: ["expected", "promising", "gap", "recommendation"],
                                        properties: {
                                            expected: { type: "string" }, promising: { type: "string" },
                                            gap: { type: "string" }, recommendation: { type: "string" }
                                        }
                                    },
                                    strengths: { type: "array", items: { type: "string" } },
                                    weaknesses: { type: "array", items: { type: "string" } },
                                    differentiators: { type: "array", items: { type: "string" } },
                                    improvements: {
                                        type: "array",
                                        items: {
                                            type: "object", additionalProperties: false,
                                            required: ["priority", "title", "action", "effect", "difficulty"],
                                            properties: {
                                                priority: { type: "string", enum: ["高", "中", "低"] }, title: { type: "string" },
                                                action: { type: "string" }, effect: { type: "string" }, difficulty: { type: "string" }
                                            }
                                        }
                                    },
                                    validationPlan: {
                                        type: "array",
                                        items: {
                                            type: "object", additionalProperties: false,
                                            required: ["experiment", "metric", "decisionRule"],
                                            properties: { experiment: { type: "string" }, metric: { type: "string" }, decisionRule: { type: "string" } }
                                        }
                                    },
                                    questions: { type: "array", items: { type: "string" } }
                                }
                            }
                        }
                    }
                }
            }
        };
    }
    if (promptKey !== 'internships') {
        return { type: "json_object" };
    }

    return {
        type: "json_schema",
        json_schema: {
            name: "internship_recommendations",
            strict: true,
            schema: {
                type: "object",
                additionalProperties: false,
                required: ["data"],
                properties: {
                    data: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: [
                                "companyName",
                                "deadline",
                                "documents",
                                "content",
                                "fitReason",
                                "checkNote"
                            ],
                            properties: {
                                companyName: { type: "string" },
                                deadline: { type: "string" },
                                documents: { type: "string" },
                                content: { type: "string" },
                                fitReason: { type: "string" },
                                checkNote: { type: "string" }
                            }
                        }
                    }
                }
            }
        }
    };
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
