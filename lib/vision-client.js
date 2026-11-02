// Task-routed OpenAI-compatible multimodal client.
//
// One vision sidecar, several jobs: each task (`map` / `read` / `zoom` /
// `check`) can route to its own model (a cheap one for transcription, a
// grounding-strong one for mapping), falling back to the primary model.
// Request policy follows the research-backed rules: temperature 0 for
// grounding and transcription, JSON mode without max_tokens (so output can
// never truncate mid-JSON), tolerant retry of transient failures, and API
// keys redacted from every error surface.
export class VisionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VisionError';
    }
}
const MODEL_BY_TASK = {
    map: 'modelMap',
    read: 'modelRead',
    zoom: 'modelZoom',
    check: 'modelCheck',
};
function resolveModel(config, task) {
    const override = config[MODEL_BY_TASK[task]];
    return override || config.model;
}
function assertConfigured(config, task) {
    const model = resolveModel(config, task);
    const missing = [];
    if (!config.apiKey)
        missing.push('VISION_API_KEY');
    if (!config.baseURL)
        missing.push('VISION_BASE_URL');
    if (!model)
        missing.push(`VISION_MODEL (or VISION_MODEL_${task.toUpperCase()})`);
    if (missing.length > 0) {
        throw new VisionError(`vision API is not configured for task "${task}"; set ${missing.join(' / ')} in the environment or the dsh-vision plugin config`);
    }
}
function contentText(content) {
    if (typeof content === 'string')
        return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
            .trim();
    }
    return '';
}
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
function endpointList(config, task) {
    const primary = { apiKey: config.apiKey, baseURL: config.baseURL, model: resolveModel(config, task) };
    const entries = [primary, ...config.chain.filter((entry) => entry.baseURL && entry.model)];
    // A chain entry without its own key inherits the primary's.
    return entries.map((entry) => ({ ...entry, apiKey: entry.apiKey || config.apiKey }));
}
export async function callVision(config, options) {
    assertConfigured(config, options.task);
    const useJsonMode = options.jsonMode === true;
    const temperature = useJsonMode || options.deterministic === true || options.task === 'map' || options.task === 'check' ? 0 : undefined;
    const failures = [];
    for (const endpoint of endpointList(config, options.task)) {
        if (options.signal?.aborted)
            break;
        try {
            return await callEndpoint(endpoint, config.timeoutMs, options, temperature, useJsonMode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${endpoint.model}@${endpoint.baseURL}: ${message}`);
        }
    }
    throw new VisionError(`all ${failures.length} vision endpoint(s) failed:\n- ${failures.join('\n- ')}`);
}
async function callEndpoint(endpoint, timeoutMs, options, temperature, useJsonMode) {
    const baseURL = endpoint.baseURL.replace(/\/+$/, '');
    const payload = {
        model: endpoint.model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: options.prompt },
                    ...options.images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
                ],
            },
        ],
    };
    if (temperature !== undefined)
        payload.temperature = temperature;
    if (!useJsonMode && options.maxTokens !== undefined)
        payload.max_tokens = options.maxTokens;
    let jsonModeRetried = false;
    for (let attempt = 0;; attempt++) {
        if (options.signal?.aborted)
            throw new VisionError('cancelled');
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` };
        // response_format survives transient retries; it is dropped ONLY after the
        // endpoint rejects it explicitly (the 400 path below).
        if (useJsonMode && !jsonModeRetried)
            payload.response_format = { type: 'json_object' };
        else
            delete payload.response_format;
        try {
            const response = await fetch(`${baseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
                // Some endpoints reject response_format outright: retry once without it.
                if (response.status === 400 && useJsonMode && !jsonModeRetried) {
                    jsonModeRetried = true;
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }
                const body = (await response.text()).slice(0, 400).replace(/\r/g, ' ').replace(/\n/g, ' ').replaceAll(endpoint.apiKey, '<redacted>');
                if (RETRYABLE_STATUS.has(response.status) && attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
                    continue;
                }
                throw new VisionError(`HTTP ${response.status}: ${body}`);
            }
            const data = await response.json();
            const record = data;
            const message = record.choices?.[0]?.message;
            // Thinking-style VL models (e.g. NVIDIA nemotron-*-vl) may leave
            // `content` null and put everything in `reasoning_content` when the
            // token budget is consumed by reasoning; salvage it instead of
            // failing with "empty answer".
            const answer = contentText(message?.content) || contentText(message?.reasoning_content);
            if (!answer)
                throw new VisionError('empty answer');
            return answer;
        }
        catch (error) {
            if (error instanceof VisionError)
                throw error;
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
                continue;
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new VisionError(`network error: ${reason}`);
        }
    }
}
