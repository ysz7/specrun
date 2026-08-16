+++
id = "structured-output"
title = "Structured output"
use_when = "The model's output feeds code and has to parse every time: JSON that keeps failing, schema-constrained decoding, tool-call schemas, validation and repair"
pack = "prompting"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Structured Output

> Getting a model to emit data your code can parse reliably — via schema-constrained decoding, tool-call schemas, or prompt-plus-validate-plus-repair — and handling the cases where it still fails.

**Tier:** foundational
**Use when:** the model's output feeds code rather than a human.
**Avoid when:** the output is prose for a person to read. Forcing JSON on a task that wants prose degrades the content.
**Cost profile:** free with constrained decoding. Prompt-and-repair costs an extra call on the failure rate.

---

## 1. Problem it solves

`json.loads(response)` fails in production in a dozen specific ways: markdown fences, a preamble ("Here is the JSON you requested:"), trailing commas, a truncated object because `max_tokens` was hit, an unescaped quote inside a string, or a number where a string was expected.

There are three mechanisms, in descending order of reliability, and you should always use the strongest one your provider supports:

1. **Constrained decoding / strict schema mode** — the sampler cannot emit a token that would violate the schema. Syntactically impossible to fail.
2. **Tool-call schemas** — the model's tool-use path is trained for schema adherence and validated by the API.
3. **Prompt + validate + repair** — the fallback. Works, but needs an explicit repair loop and costs a retry.

None of them guarantee **semantic** correctness. A schema-valid object can still contain a hallucinated value. Validation is a separate layer from parsing.

## 2. Shape

```
                          ┌──────────────────────────────────────┐
   schema (Pydantic) ────▶│ 1. constrained decoding / strict mode │──▶ always parses
                          └──────────────────────────────────────┘
                                        │ not supported
                                        ▼
                          ┌──────────────────────────────────────┐
                          │ 2. tool-call schema                   │──▶ near-always parses
                          └──────────────────────────────────────┘
                                        │ not applicable
                                        ▼
                          ┌──────────────────────────────────────┐
                          │ 3. prompt + parse                     │
                          │      ├─ ok  ─────────────────────────┼──▶
                          │      └─ fail → repair with the error ─┘  (≤2 attempts)
                          └──────────────────────────────────────┘
                                        │
                                        ▼
                          ┌──────────────────────────────────────┐
                          │ SEMANTIC validation (separate layer)  │
                          │ ranges, cross-field rules, ids exist  │
                          └──────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Schema | The contract | Pydantic, zod, JSON Schema | Over-nested; the model loses track |
| Constrained decoder | Make violations impossible | Provider strict mode, outlines, guidance | Not used when available |
| Extractor | Pull JSON from a mixed response | Regex for fenced or braced blocks | Naive `find('{')` breaks on nested braces |
| Validator (syntactic) | Parse and type-check | Pydantic | Confused with semantic validation |
| Validator (semantic) | Business rules, ranges, referential integrity | Custom | Skipped entirely |
| Repair loop | Feed the error back for one retry | Same model + error text | Unbounded retries |
| Truncation guard | Detect `max_tokens` cutoff | Finish-reason check | Diagnosed as a "JSON error" |

## 4. Data flow

1. Define the schema in code; generate JSON Schema from it. Never hand-maintain both.
2. Call the model with the strongest available mechanism.
3. If output is free text, extract the JSON block robustly.
4. Parse and type-validate. On failure, **check the finish reason first** — a truncated response is a `max_tokens` problem, not a prompt problem, and retrying with the same limit fails identically.
5. Repair: return the exact validation error as an instruction. Cap at two attempts.
6. Validate semantically: ranges, cross-field consistency, referenced ids exist.
7. Log the raw response on every failure — you cannot debug what you did not keep.

## 5. Contracts

```python
from pydantic import BaseModel, Field, field_validator
from typing import Literal

class TicketExtraction(BaseModel):
    model_config = {"extra": "forbid"}

    issue: str = Field(max_length=200, description="The primary problem, in one sentence.")
    severity: Literal["critical", "high", "medium", "low"]
    severity_quote: str = Field(description="The exact phrase from the ticket that drove severity.")
    product_area: str | None = Field(None, description="null if not stated. Do not infer.")
    affected_users: int | None = Field(None, ge=0, description="null if not stated.")

    @field_validator("severity_quote")
    @classmethod
    def quote_must_be_short(cls, v: str) -> str:
        # Semantic rule: a "quote" that is 400 chars is a summary, not a quote.
        if len(v) > 200:
            raise ValueError("severity_quote must be a short verbatim phrase, not a summary")
        return v
```

## 6. Reference implementation

```python
import json, re, logging
from pydantic import ValidationError

FENCED = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.S)

def extract_json(text: str) -> str:
    """Robust extraction. Naive text.find('{') breaks on nested braces and prose."""
    m = FENCED.search(text)
    if m:
        return m.group(1)
    # Balanced-brace scan from the first opener.
    start = min((i for i in (text.find("{"), text.find("[")) if i != -1), default=-1)
    if start == -1:
        raise ValueError("No JSON object or array found in the response")
    opener, closer = (("{", "}") if text[start] == "{" else ("[", "]"))
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if esc:      esc = False
            elif ch == "\\": esc = True
            elif ch == '"': in_str = False
        elif ch == '"':   in_str = True
        elif ch == opener: depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise ValueError("Unterminated JSON — response was likely truncated")

def call_structured(system: str, user: str, model_cls, max_repairs: int = 2):
    schema = model_cls.model_json_schema()
    messages = [{"role": "user", "content": user}]
    sys = system + f"\n\nReturn JSON matching this schema and nothing else:\n{json.dumps(schema)}"

    for attempt in range(max_repairs + 1):
        resp = client.messages.create(model="<MODEL_ID>", max_tokens=4096,
                                      temperature=0, system=sys, messages=messages)
        raw = resp.content[0].text

        # Diagnose truncation BEFORE blaming the JSON. Retrying won't help here.
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("Response hit max_tokens; raise the limit or reduce the schema")

        try:
            return model_cls.model_validate_json(extract_json(raw))
        except (ValidationError, ValueError, json.JSONDecodeError) as e:
            logging.warning("structured output attempt %d failed: %s\nraw=%r", attempt, e, raw[:500])
            if attempt == max_repairs:
                raise
            messages += [
                {"role": "assistant", "content": raw},
                # The error text IS the instruction. Make it actionable.
                {"role": "user", "content":
                    f"That output failed validation:\n{e}\n\n"
                    f"Return only the corrected JSON. No prose, no markdown fences."},
            ]
```

Tool-call schemas — more reliable than prompting when strict mode is unavailable:

```python
resp = client.messages.create(
    model="<MODEL_ID>", max_tokens=2000,
    tools=[{"name": "record_extraction",
            "description": "Record the extracted ticket fields.",
            "input_schema": TicketExtraction.model_json_schema()}],
    tool_choice={"type": "tool", "name": "record_extraction"},   # force it
    messages=[{"role": "user", "content": ticket}])
data = TicketExtraction.model_validate(
    next(b.input for b in resp.content if b.type == "tool_use"))
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Mechanism | strongest available | Reliability | Always prefer constrained decoding |
| `max_repairs` | 2 | Cost of failure | 1 for latency-critical paths |
| Schema depth | ≤ 3 levels | Model adherence | Flatten; deep nesting degrades reliability sharply |
| Optional fields | explicit `\| None` with "null if not stated" | Hallucinated values | Always describe the null case |
| `max_tokens` | 2× expected output | Truncation | Size to the largest realistic output |
| Temperature | 0 | Determinism | Always 0 for extraction |
| Field count | ≤ 15 per object | Adherence | Split into multiple calls beyond that |
| `additionalProperties` | false | Extra-key drift | Always false |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| JSON truncated mid-object | `max_tokens` reached | Finish reason | Raise the limit; shrink the schema. Retrying is useless. |
| Markdown fences around JSON | Model's default formatting | Parse failure | Robust extraction; "no markdown fences" in the prompt |
| Preamble text before JSON | Model narrating | Parse failure | Constrained decoding, or tool-call mode |
| Fields hallucinated instead of null | Null case not described | Sample-audit against source | "Return null if not stated. Do not infer." per field |
| Enum value not in the enum | Not using strict mode | Validation errors | Constrained decoding; `Literal` types |
| Schema-valid but wrong values | No semantic validation | Downstream errors | A separate semantic validation layer |
| Repair loop never converges | Error message is not actionable | Repair success rate | Return the validation error verbatim as an instruction |
| Deeply nested output degrades | Schema depth | Errors correlate with depth | Flatten to ≤ 3 levels; split into calls |

## 9. Anti-patterns

- **Prompting for JSON when strict mode exists.** You are choosing a failure rate you did not need.
- **`text.find('{')` … `text.rfind('}')`.** Breaks on nested objects and on prose containing braces.
- **Treating truncation as a JSON error.** Retrying with the same `max_tokens` fails identically forever.
- **Skipping semantic validation.** A schema-valid response can still contain a fabricated order id.
- **Deeply nested schemas.** Reliability drops sharply with depth. Flatten.
- **Unbounded repair loops.** Cap at two; beyond that the model is not going to get it.
- **Discarding the raw response on failure.** The one artifact you need for debugging.
- **Forcing JSON on prose tasks.** Structure the *envelope*, leave the prose field free.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| First-attempt parse rate | Valid without repair | ≥ 99% | < 95% |
| Repair success rate | Valid after repair / repairs | ≥ 80% | < 50% |
| Truncation rate | Responses hitting `max_tokens` | < 0.1% | > 1% |
| Semantic validation failures | Schema-valid but rule-violating | < 2% | > 5% |
| Null-when-unknown accuracy | Correct nulls / should-be-null | ≥ 95% | < 85% |
| Extra cost from repairs | Repair tokens / total | < 3% | > 10% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Prompt for JSON, `json.loads` |
| v1 | Parse failures in production | Robust extraction + Pydantic validation + logging raw |
| v2 | Failures persist | Repair loop with the validation error as instruction |
| v3 | Reliability required | Tool-call schema with forced `tool_choice` |
| v4 | Provider supports it | Constrained decoding / strict schema mode |
| v5 | Wrong values, valid shape | Semantic validation layer with business rules |

## 12. Build checklist

- [ ] The schema is defined once in code; JSON Schema is generated from it.
- [ ] The strongest available mechanism is in use (constrained > tool-call > prompt).
- [ ] `additionalProperties: false` on every object.
- [ ] Every optional field's description states when to return null.
- [ ] Schema depth ≤ 3 and field count ≤ 15 per object.
- [ ] Finish reason is checked before diagnosing a parse failure.
- [ ] JSON extraction handles fences, preambles, and nesting.
- [ ] Repairs are capped at 2 and pass the validation error verbatim.
- [ ] A separate semantic validation layer checks ranges, cross-field rules, and referential integrity.
- [ ] Raw responses are logged on every failure.
- [ ] Temperature is 0.

## 13. Related

- [prompt-structure.md](prompt-structure.md) — where the output contract lives in the prompt
- [prompt-chaining.md](prompt-chaining.md) — gates between chained steps
- [tool-design.md](tool-design.md) — schema design for tools
- [llm-as-judge.md](llm-as-judge.md) — structured judge output
