import type { HandoffCandidate } from "./types.js";

interface HandoffParseResult {
  handoff: HandoffCandidate | null;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonMaybe(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function extractFencedJson(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : null;
}

function extractBalancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractBalancedObject(text: string): string | null {
  let start = text.indexOf("{");
  while (start !== -1) {
    const candidate = extractBalancedObjectAt(text, start);
    if (candidate && parseJsonMaybe(candidate)) {
      return candidate;
    }
    start = text.indexOf("{", start + 1);
  }

  return null;
}

function parseObjectFromText(text: string): Record<string, unknown> | null {
  const direct = parseJsonMaybe(text.trim());
  if (direct) return direct;

  const fenced = extractFencedJson(text);
  if (fenced) {
    const parsedFence = parseJsonMaybe(fenced);
    if (parsedFence) return parsedFence;
  }

  const balanced = extractBalancedObject(text);
  return balanced ? parseJsonMaybe(balanced) : null;
}

function handoffFromParsed(value: Record<string, unknown> | null): HandoffCandidate | null {
  if (value?.schema_version === "handoff.v1") {
    return value as HandoffCandidate;
  }
  if (isRecord(value?.handoff) && value.handoff.schema_version === "handoff.v1") {
    return value.handoff as HandoffCandidate;
  }
  return null;
}

function candidateTextsFromJsonEvent(event: Record<string, unknown>): string[] {
  const candidates: string[] = [];

  if (event?.schema_version === "handoff.v1") {
    candidates.push(JSON.stringify(event));
  }
  if (isRecord(event.item) && typeof event.item.text === "string") {
    candidates.push(event.item.text);
  }
  if (typeof event?.result === "string") {
    candidates.push(event.result);
  }
  if (isRecord(event.message) && Array.isArray(event.message.content)) {
    for (const part of event.message.content) {
      if (isRecord(part) && typeof part.text === "string") {
        candidates.push(part.text);
      }
    }
  }

  return candidates;
}

export function parseHandoffFromRaw(raw: string): HandoffParseResult {
  const full = parseObjectFromText(raw);
  const fullHandoff = handoffFromParsed(full);
  if (fullHandoff) {
    return { handoff: fullHandoff, errors: [] };
  }

  const candidates = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseJsonMaybe(trimmed);
    if (event) {
      candidates.push(...candidateTextsFromJsonEvent(event));
    } else {
      candidates.push(trimmed);
    }
  }

  for (const candidate of candidates) {
    const parsed = parseObjectFromText(candidate);
    const handoff = handoffFromParsed(parsed);
    if (handoff) {
      return { handoff, errors: [] };
    }
  }

  return {
    handoff: null,
    errors: ["No handoff.v1 JSON object found in adapter output."]
  };
}
