export type ToolShape = "Flat" | "Ball" | "V";
export type FillMode = "Pocket" | "Contour";
export type EngraveType = "outline" | "pocket" | "raster" | "skeleton";
export type PathAnchor =
  | "TopLeft"
  | "TopCenter"
  | "TopRight"
  | "MiddleLeft"
  | "Center"
  | "MiddleRight"
  | "BottomLeft"
  | "BottomCenter"
  | "BottomRight";

/**
 * Per-job partition sent to the Rust CAM pass. When present and non-empty, the
 * emitter splits the program at job boundaries, writes a `; === JOB N/M …`
 * header block per job, and inserts `M0` between jobs so the machine UI can
 * prompt the user to realign the handheld router before resuming.
 *
 * Each job's geometry is rebased to its own local zero at the specified
 * `path_anchor`, so drift accumulated during the job stays bounded by the
 * job's own extent rather than the whole program.
 */
export interface JobSpec {
  /** Stable id from the frontend (matches `Job.id` in the editor store). */
  id: string;
  /** Human name — shown in gcode comments and the machine-side modal. */
  name: string;
  /** Operation ids (from `FrontendOperation.id`) that belong to this job. */
  operation_ids: string[];
  /** Anchor selector for the job's local-zero origin. */
  path_anchor: PathAnchor;
  /** Pencil-cross offset measured from the artboard's bottom-left corner (mm).
   *  `[x_from_left_edge, y_from_bottom_edge]` — what the user scribes on wood. */
  cross_offset_from_artboard_bl: [number, number];
  /** True when auto-detection tagged this job as the passe-partout / frame. */
  is_big_spanner: boolean;
  /** Optional explicit anchor point in artboard-mm (origin = top-left, y grows
   *  down). When set, Rust uses this point as the job's local-zero instead of
   *  deriving it from `path_anchor` + toolpath bounds. The frontend populates
   *  this when `alignJobAnchors` snapped the anchor off the enum-derived
   *  position so the gcode zero matches the pencil cross shown in the UI. */
  anchor_point_override: [number, number] | null;
}

export interface Settings {
  conversion: {
    tolerance: number;
    feedrate: number;
    dpi: number;
    origin: [number | null, number | null];
    extra_attribute_name: string | null;
    optimize_path_order: boolean;
    anchor: PathAnchor;
    /** Radius (mm) for the post-TSP cluster-detour pass; null disables. */
    cluster_detour_radius: number | null;
    selector_filter: string | null;
    /** Per-job partition. `null` or empty → emit a single contiguous program
     *  with the top-level `anchor` (legacy path). */
    jobs: JobSpec[] | null;
  };
  engraving: {
    enabled: boolean;
    material_width: number;
    material_height: number;
    material_thickness: number;
    tool_diameter: number;
    tool_shape: ToolShape;
    target_depth: number;
    max_stepdown: number;
    cut_feedrate: number;
    shallow_cut_feedrate: number | null;
    plunge_feedrate: number;
    stepover: number;
    max_fill_passes: number | null;
    fill_mode: FillMode;
    svg_width_override: number | null;
    placement_x: number;
    placement_y: number;
    machine_width: number;
    machine_height: number;
  };
  machine: {
    supported_functionality: {
      circular_interpolation: boolean;
    };
    travel_z: number | null;
    cut_z: number | null;
    plunge_feedrate: number | null;
    path_begin_sequence: string | null;
    tool_on_sequence: string | null;
    tool_off_sequence: string | null;
    begin_sequence: string | null;
    end_sequence: string | null;
  };
  postprocess: {
    checksums: boolean;
    line_numbers: boolean;
    newline_before_comment: boolean;
  };
  version: string;
}

export interface SvgTreeNode {
  id: string | null;
  label: string;
  tag_name: string;
  selectable: boolean;
  selectable_descendant_ids: string[];
  children: SvgTreeNode[];
}

export interface PreparedSvgDocument {
  normalized_svg: string;
  tree: SvgTreeNode;
  selectable_element_ids: string[];
}

export interface SvgDocumentMetrics {
  /** viewBox x origin (internal coordinate system) */
  x: number;
  /** viewBox y origin (internal coordinate system) */
  y: number;
  /** viewBox width (internal coordinate units, for scaling) */
  width: number;
  /** viewBox height (internal coordinate units, for scaling) */
  height: number;
  /** Physical width in millimeters */
  widthMm: number;
  /** Physical height in millimeters */
  heightMm: number;
  aspectRatio: number;
}

export interface ArtObject {
  id: string;
  name: string;
  preparedSvg: PreparedSvgDocument;
  svgMetrics: SvgDocumentMetrics;
  placementX: number;
  placementY: number;
  widthMm: number;
  heightMm: number;
  aspectLocked: boolean;
  elementAssignments: Record<string, ElementAssignment>;
  elementColors?: Map<string, string>;
}

export interface FrontendOperation {
  id: string;
  name: string;
  target_depth_mm: number;
  assigned_element_ids: string[];
  color: string | null;
  engrave_type?: EngraveType | null;
  fill_mode?: FillMode | null;
  allow_thicken_routing?: boolean;
  /** Editor job id for multi-job output. Operations with different job ids stay separate. */
  jobId?: string;
  /** Minimum cut-order index across the operation's contributing elements. Drives
   *  deterministic operation ordering on the Rust side and is stamped into the
   *  `;operation:start:…` marker so the parser can round-trip the order. */
  cut_order_index?: number | null;
}

export interface ElementAssignment {
  elementId: string;
  targetDepthMm: number;
  engraveType: EngraveType | null;
  fillMode: FillMode | null;
  /** Group id (from the editor's SVG tree) that batches this element with its siblings for cutting.
   *  Elements sharing a cutOrderGroupId are emitted as one contiguous FrontendOperation. */
  cutOrderGroupId?: string;
  /** Global 0-based sort index across every element; used to order operations to minimize wander. */
  cutOrderIndex?: number;
  /** Editor job id for multi-job output. */
  jobId?: string;
}

export interface AssignmentProfileGroup {
  key: string;
  targetDepthMm: number;
  engraveType: EngraveType | null;
  fillMode: FillMode | null;
  elementIds: string[];
  color: string;
  /** The SVG group id that batches these elements (set when cut-order data is available). */
  cutOrderGroupId?: string;
  /** Minimum cut-order index across this group's elements; drives operation ordering. */
  minCutOrderIndex?: number;
  /** Editor job id for multi-job output. */
  jobId?: string;
}

export interface GenerateJobRequest {
  normalized_svg: string;
  settings: Settings;
  operations: FrontendOperation[];
}

export interface OperationLineRange {
  operation_id: string;
  operation_name: string;
  color: string | null;
  start_line: number;
  end_line: number;
  /** Cut-order index extracted from the `;operation:start:` marker. `null`
   *  for legacy gcode that predates the index field. */
  cut_order_index?: number | null;
}

export interface GenerateJobResponse {
  gcode: string;
  warnings: string[];
  operation_ranges: OperationLineRange[];
  preview_snapshot: {
    material_width: number;
    material_height: number;
    material_thickness: number;
    tool_diameter: number;
  };
}

export interface JobProgress {
  phase: "processing" | "optimizing" | "formatting";
  current: number;
  total: number;
}
