function parseJsonMaybe(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function extractFencedJson(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : null;
}

function extractBalancedObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

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

function parseObjectFromText(text) {
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

function candidateTextsFromJsonEvent(event) {
  const candidates = [];

  if (event?.schema_version === "handoff.v1") {
    candidates.push(JSON.stringify(event));
  }
  if (typeof event?.item?.text === "string") {
    candidates.push(event.item.text);
  }
  if (typeof event?.result === "string") {
    candidates.push(event.result);
  }
  if (Array.isArray(event?.message?.content)) {
    for (const part of event.message.content) {
      if (typeof part?.text === "string") {
        candidates.push(part.text);
      }
    }
  }

  return candidates;
}

export function parseHandoffFromRaw(raw) {
  const full = parseObjectFromText(raw);
  if (full?.schema_version === "handoff.v1") {
    return { handoff: full, errors: [] };
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
    if (parsed?.schema_version === "handoff.v1") {
      return { handoff: parsed, errors: [] };
    }
  }

  return {
    handoff: null,
    errors: ["No handoff.v1 JSON object found in adapter output."]
  };
}

