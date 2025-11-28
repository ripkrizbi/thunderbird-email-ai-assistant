import { log, error } from '../core/debug.js';

export function extractJson(text) {
    log("Extracting JSON from text, length:", text.length);
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    log("First brace at:", firstBrace, "Last brace at:", lastBrace);

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        error("Could not find a valid JSON object. Text preview:", text.substring(0, 500));
        throw new Error("Could not find a valid JSON object in the response.");
    }
    const extracted = text.substring(firstBrace, lastBrace + 1);
    log("Extracted JSON length:", extracted.length);
    return extracted;
}