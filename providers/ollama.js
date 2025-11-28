import { buildPrompt } from '../core/analysis.js';
import {extractJson} from "./utils";
import { log, error } from '../core/debug.js';

export async function analyzeWithOllama(settings, structuredData, customTags) {
  const prompt = buildPrompt(structuredData, customTags);
  const { ollamaApiUrl, ollamaModel, ollamaApiTimeout } = settings;
  const timeoutMs = (ollamaApiTimeout || 120) * 1000; // Convert seconds to milliseconds
  
  log("Spam-Filter Extension: Ollama Analysis Starting");
  log("Ollama URL:", ollamaApiUrl);
  log("Ollama Model:", ollamaModel);
  log("Ollama Timeout:", ollamaApiTimeout, "seconds");
  log("Prompt length:", prompt.length);

  try {
    log("Sending request to Ollama API...");
    
    // Create an abort controller with configurable timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(ollamaApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: prompt,
          format: "json",
          stream: false
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      log("Ollama API Response Status:", response.status, response.statusText);
      
      if (!response.ok) {
        const errorText = await response.text();
        error("Ollama API Error Response:", errorText);
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      log("Ollama Response received, response length:", result.response.length);
      log("Ollama raw response:", result.response.substring(0, 200) + "...");

      const rawText = result.response;
      const jsonText = extractJson(rawText);
      log("Extracted JSON:", jsonText.substring(0, 200) + "...");
      
      const parsed = JSON.parse(jsonText);
      log("Parsed analysis result:", parsed);
      return parsed;
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        error(`Ollama API timeout (${ollamaApiTimeout}s) - Connection unavailable or too slow at ${ollamaApiUrl}`);
      } else {
        error(`Ollama API Error (URL: ${ollamaApiUrl}, model: ${ollamaModel}):`, fetchErr);
      }
      throw fetchErr;
    }
  } catch (err) {
    error(`Ollama Error (URL: ${ollamaApiUrl}, model: ${ollamaModel}):`, err);
    return null;
  }
}
