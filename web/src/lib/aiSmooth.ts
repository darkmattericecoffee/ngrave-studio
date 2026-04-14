export const OPENROUTER_API_KEY_STORAGE = 'openrouter_api_key'

export const AI_SMOOTH_SYSTEM_PROMPT = `You are an SVG path smoother and path repairer. The input SVG contains centerline paths traced by an automatic algorithm. Your job is to output the SAME paths with smoother curves and better-organized subpath structure. You must NOT delete, merge, move, shorten, or reinterpret any stroke. Every \`M\` subpath in the input must appear as a corresponding stroke in the output, in roughly the same position.

Your primary goals are:
1. smooth jagged but valid curves
2. repair malformed cubic Bézier segments that are clearly acting as accidental spikes, bows, loops, or failed straight segments

What you MAY do

* Refit jagged or stair-stepped cubic Béziers into smoother cubic Béziers that stay within ~0.2 units of the original path at all points, before any transform is applied.
* Round coordinates to 2 decimal places.
* Reorder subpaths inside a \`<path>\` element so pen-up moves are minimized.
* Combine multiple adjacent \`<path>\` elements into one \`<path>\` with multiple \`M\` subpaths, preserving every subpath.
* If a single subpath contains multiple consecutive coordinates that are very close together (within ~0.3 units of each other), interpret this as a noisy or stuttering trace of one intended curve and refit it into a single clean Bézier segment covering that region. This applies only within one subpath, never across subpath boundaries.
* Detect malformed cubic Bézier commands that are not plausible intended curves, but are instead accidental outlier-control-point artifacts from tracing or export.

A cubic Bézier segment should be treated as malformed and eligible for repair when one or more of the following are true:

* The control points are extreme outliers relative to the segment's start and end points.
* The control polygon length is much larger than the direct distance from the current point to the segment endpoint.
* One or both control points would create an obvious spike, loop, bow, or self-crossing detour that is inconsistent with the local stroke direction.
* The segment visually behaves like a single straight or nearly straight connector, but the cubic control points introduce a large unnecessary excursion.
* The cubic's endpoint is reasonable, but its control points are implausible compared with neighboring segments in the same subpath.

When repairing a malformed cubic Bézier:

* If the intended segment is straight or nearly straight, replace the entire cubic with a single \`L\` command to the cubic endpoint only.
* Never convert cubic control points into intermediate \`L\` points.
* Do not preserve spike-causing control handles.
* Keep the segment connected to the same start point and the same endpoint.
* Prefer the minimal repair that removes the artifact while preserving the intended stroke path.

What you MUST NOT do

* Do NOT delete any subpath, even if it looks redundant, short, or artifact-like.
* Do NOT merge two separate subpaths into one continuous stroke.
* Do NOT shorten, trim, or extend any path.
* Do NOT move endpoints to snap onto other paths.
* Do NOT adjust a subpath's shape based on its spatial relationship to any other subpath. Each subpath must be smoothed or repaired in isolation, as if no other subpaths exist.
* Do NOT re-center or reinterpret control points based on proximity to neighboring subpaths or perceived cross-subpath cluster geometry.
* Do NOT change stroke color, width, fill, transforms, viewBox, or width/height.
* Do NOT add anything that wasn't in the input.

Important repair rule:
If a cubic Bézier is replaced by a straight segment, the replacement must be:
\`L endX endY\`
where \`endX endY\` are the endpoint of the cubic command only.
Do not emit:
\`L control1X control1Y L control2X control2Y L endX endY\`

Output requirements

* Return ONE self-contained SVG and nothing else.
* No prose, no markdown fences.
* Preserve every \`transform="..."\` attribute verbatim.
* Use \`fill="none"\`, \`stroke-linecap="round"\`, \`stroke-linejoin="round"\`.`

/** Wrap a raw SVG path data string in a minimal SVG for the AI to process */
export function buildSvgForSmoothing(pathData: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="500" viewBox="0 0 600 500">
  <path d="${pathData}" fill="none" stroke="#000000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
</svg>`
}

/** Strip markdown code fences that some models wrap SVG output in */
function stripMarkdownFences(text: string): string {
  // Matches ```svg ... ``` or ``` ... ``` with optional whitespace
  return text.replace(/^```(?:svg|xml)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
}

/** Extract the `d` attribute from the first <path> in an SVG string */
export function extractPathDataFromSvg(rawText: string): string | null {
  const svgText = stripMarkdownFences(rawText)
  console.debug('[aiSmooth] raw response length:', rawText.length)
  console.debug('[aiSmooth] first 300 chars:', svgText.slice(0, 300))

  // 1. Try DOM parsing — use multiple lookup strategies for cross-browser safety
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  if (!doc.querySelector('parsererror')) {
    const pathEl =
      doc.querySelector('path') ??
      doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'path')[0] ??
      doc.getElementsByTagName('path')[0]

    const d = pathEl?.getAttribute('d') ?? null
    if (d) return d
    console.warn('[aiSmooth] DOM parsed OK but no <path d> found — falling back to regex')
  } else {
    console.warn('[aiSmooth] DOMParser reported parseerror — falling back to regex')
  }

  // 2. Regex fallback: handles namespace quirks and partial parse failures
  const match = svgText.match(/\sd="([\s\S]*?)"(?:\s|\/)/) ?? svgText.match(/\sd='([\s\S]*?)'(?:\s|\/)/)
  if (match?.[1]) {
    console.debug('[aiSmooth] extracted d via regex fallback')
    return match[1]
  }

  console.warn('[aiSmooth] could not extract path data from:', svgText.slice(0, 500))
  return null
}

/**
 * Stream an AI-smooth request to OpenRouter.
 * Resolves with the full response text when done.
 */
export async function streamAiSmooth(
  svgString: string,
  apiKey: string,
  model = 'openai/gpt-4o-mini',
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Engrav CNC Editor',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AI_SMOOTH_SYSTEM_PROMPT },
        { role: 'user', content: svgString },
      ],
      stream: true,
    }),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`OpenRouter ${response.status}: ${errText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let accumulated = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value, { stream: true })
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') break
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const content = parsed.choices?.[0]?.delta?.content
        if (content) accumulated += content
      } catch {
        // ignore malformed SSE lines
      }
    }
  }

  return accumulated
}
