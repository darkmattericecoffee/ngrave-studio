import { Description, Label, Switch } from '@heroui/react'

import { useEditorStore } from '../../store'
import type { DowelHoleParams } from '../../types/editor'
import { GeneratorFormField } from './GeneratorFormField'
import { useGeneratorForm } from './useGeneratorForm'

interface DowelHoleFormProps {
  initialParams: DowelHoleParams
  mode: 'new' | 'edit'
  nodeId?: string
  onPlace?: (params: DowelHoleParams) => void
  onUpdate?: (params: DowelHoleParams) => void
}

export function DowelHoleForm({ initialParams, mode, nodeId, onPlace, onUpdate }: DowelHoleFormProps) {
  const toolDiameter = useEditorStore((s) => s.machiningSettings.toolDiameter)
  const { draft, setPatch } = useGeneratorForm(initialParams, mode, nodeId)
  const p = draft as DowelHoleParams

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Shape</p>
        <div className="space-y-3">
          <Switch
            isSelected={p.matchToolDiameter}
            onChange={(checked) => setPatch({
              matchToolDiameter: checked,
              diameter: checked ? toolDiameter : p.diameter,
            })}
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label className="text-sm text-foreground">Match router bit</Label>
              <Description className="text-xs text-muted-foreground">
                Diameter follows the active bit diameter ({toolDiameter} mm).
              </Description>
            </Switch.Content>
          </Switch>
          <GeneratorFormField
            label="Diameter"
            value={p.matchToolDiameter ? toolDiameter : p.diameter}
            unit="mm"
            disabled={p.matchToolDiameter}
            onChange={(v) => setPatch({ diameter: v })}
          />
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Distribution</p>
        <div className="space-y-2">
          <GeneratorFormField label="Columns" value={p.colCount} min={1} max={50} step={1} onChange={(v) => setPatch({ colCount: Math.max(1, Math.round(v)) })} />
          <GeneratorFormField label="Col spacing" value={p.colSpacing} unit="mm" onChange={(v) => setPatch({ colSpacing: v })} />
          <GeneratorFormField label="Rows" value={p.rowCount} min={1} max={50} step={1} onChange={(v) => setPatch({ rowCount: Math.max(1, Math.round(v)) })} />
          <GeneratorFormField label="Row spacing" value={p.rowSpacing} unit="mm" onChange={(v) => setPatch({ rowSpacing: v })} />
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Output</p>
        {p.matchToolDiameter ? (
          <div className="rounded-xl bg-[var(--surface-secondary)] px-3 py-2 text-xs text-muted-foreground">
            Plunge (forced for bit-diameter holes)
          </div>
        ) : (
          <div className="flex gap-1">
            {(['contour', 'pocket'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setPatch({ outputType: type })}
                className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
                  p.outputType === type
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-[var(--surface-secondary)] text-muted-foreground hover:text-foreground'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === 'new' && onPlace && (
        <button
          onClick={() => onPlace(p)}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Place on artboard
        </button>
      )}
      {mode === 'edit' && onUpdate && (
        <button
          onClick={() => onUpdate(p)}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Apply changes
        </button>
      )}
    </div>
  )
}
