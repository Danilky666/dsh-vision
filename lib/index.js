// dsh-vision: a visual working memory for DeepSeek Harness agents.
//
// One cordis service row registers three tools on the host `tools` registry:
//   vision_map        annotate an image into a numbered element inventory
//                     kept in visual working memory (the signature tool)
//   vision_read       ask questions about images, or extract all visible
//                     text verbatim (tall pages tiled and merged)
//   vision_zoom       inspect one region at full resolution (coarse-to-fine)
//
// Images come from the user (an uploaded attachment or a file path in the
// message) — the plugin never captures anything on its own.
// and registers the `visual-memory` skill when a skills service exists.
// The vision sidecar is any OpenAI-compatible multimodal endpoint; each
// task can route to its own model. Design references: see REFERENCES.md.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { VisualMemory } from './registry.js';
import { buildTools } from './tools.js';
import { registerSkill } from './skill-loader.js';
export const name = 'dsh-vision';
export const inject = ['tools'];
function parseFallbacksEnv() {
    const raw = process.env.VISION_FALLBACKS;
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => ({
            apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
            baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : '',
            model: typeof entry.model === 'string' ? entry.model : '',
        }));
    }
    catch {
        return [];
    }
}
// Layered config: a JSON file (default ~/.dsh/vision.json, override with
// VISION_CONFIG_FILE) takes precedence over the environment, so a key can be
// installed without restarting the host process — the plugin re-applies on
// reload and picks the values up here.
function readVisionFile() {
    try {
        const path = process.env.VISION_CONFIG_FILE || join(homedir(), '.dsh', 'vision.json');
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
const VISION_FILE = readVisionFile();
const configValue = (key, envName) => {
    const fromFile = VISION_FILE[key];
    if (typeof fromFile === 'string' && fromFile)
        return fromFile;
    return process.env[envName] ?? '';
};
const ChainSchema = Schema.array(Schema.object({
    apiKey: Schema.string().default(''),
    baseURL: Schema.string().required(),
    model: Schema.string().required(),
}));
export const Config = Schema.object({
    apiKey: Schema.string().default(configValue('apiKey', 'VISION_API_KEY')),
    baseURL: Schema.string().default(configValue('baseURL', 'VISION_BASE_URL')),
    model: Schema.string().default(configValue('model', 'VISION_MODEL')),
    modelMap: Schema.string().default(configValue('modelMap', 'VISION_MODEL_MAP')),
    modelRead: Schema.string().default(configValue('modelRead', 'VISION_MODEL_READ')),
    modelZoom: Schema.string().default(configValue('modelZoom', 'VISION_MODEL_ZOOM')),
    modelCheck: Schema.string().default(configValue('modelCheck', 'VISION_MODEL_CHECK')),
    chain: ChainSchema.default(Array.isArray(VISION_FILE.chain) ? VISION_FILE.chain : parseFallbacksEnv()),
    lang: Schema.string().default(configValue('lang', 'VISION_LANG') || 'zh'),
    timeoutMs: Schema.number().default(Number(VISION_FILE.timeoutMs) || 180000),
    maxEdge: Schema.number().default(Number(VISION_FILE.maxEdge) || 2048),
});
export function apply(ctx, config) {
    const memory = new VisualMemory();
    const tools = buildTools({
        vision: {
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            model: config.model,
            modelMap: config.modelMap,
            modelRead: config.modelRead,
            modelZoom: config.modelZoom,
            modelCheck: config.modelCheck,
            chain: config.chain,
            lang: config.lang,
            timeoutMs: config.timeoutMs,
        },
        memory,
        maxEdge: config.maxEdge,
    });
    for (const tool of tools)
        ctx.tools.register(tool);
    registerSkill(ctx);
}
