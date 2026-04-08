/**
 * n8n Code node (JavaScript)
 * Compact hierarchical layout with local search:
 * - Leaves: choose best pill columns (1..3)
 * - Non-leaves: choose best child columns (1..3) with tallest-first column balancing
 * - Top-level ordered (Core → Corporate → Enabling → others), same width
 * - Bounding box (1:√2) + background as requested
 * Returns a JSON STRING at json.diagram
 */

// ---------------- Configuration ----------------
const PAGE_LEFT = 40;
const PAGE_TOP  = 40;

// ========== COMPACT MODE CONFIGURATION ==========
// Set COMPACT_MODE = true for tighter packing with less whitespace
const COMPACT_MODE = true;

// logical container padding (scales with content in compact mode)
const LA_PAD_X = COMPACT_MODE ? 40 : 80;
const LA_PAD_TOP = COMPACT_MODE ? 60 : 120;
const LA_PAD_BOTTOM = COMPACT_MODE ? 40 : 80;

// roots (top-level logicals)
const ROOT_V_GAP = COMPACT_MODE ? 60 : 120;
const ROOT_MAX_COLS = 1; // keep single column as per your rule

// child logical layout (we'll search 1..CHILD_MAX_COLS)
const CHILD_MAX_COLS = 3;
const CHILD_H_GAP = COMPACT_MODE ? 30 : 40;
const CHILD_V_GAP = COMPACT_MODE ? 50 : 80;

// pills (physical apps) — keep width fixed
const PILL_WIDTH = 300;          // fixed
const PILL_HEIGHT = 60;
const PILL_COL_STEP = COMPACT_MODE ? 320 : 360;       // horizontal spacing between pill columns
const PILL_ROW_STEP = COMPACT_MODE ? 80 : 100;        // vertical spacing between pill rows
const PILL_MAX_COLS = 3;         // we will search 1..3

// minimum logical width — much more permissive in compact mode
const MIN_LOGICAL_WIDTH = COMPACT_MODE
  ? Math.max(500, LA_PAD_X * 2 + PILL_WIDTH)  // content-driven width
  : Math.max(1180, LA_PAD_X * 2 + PILL_WIDTH + (PILL_MAX_COLS - 1) * PILL_COL_STEP);

// Whitespace penalty: how much to penalize unused space (0..1)
// Higher value = tighter packing, lower value = more whitespace acceptable
const WHITESPACE_PENALTY = COMPACT_MODE ? 0.4 : 0.0;

const STENCIL_LOGICAL = "logicalApplication";
const STENCIL_PHYSICAL = "physicalApplication";
const STENCIL_BBOX = "boundingBox";
const STENCIL_BG = "templateBackground";

const DIAGRAM_ID = "auto-layout";
const DIAGRAM_TITLE = "System Architecture";

// Sorting preferences
const SORT_LOGICAL_AZ = true;
const SORT_PHYSICAL_AZ = false;

// Soft aspect target and weight for cost
// Lower weight in compact mode to allow flexibility while preventing extreme aspect ratios
const TARGET_RATIO = Math.SQRT2;                              // ≈ 1.414 (ISO paper ratio, always enabled)
const ASPECT_W = COMPACT_MODE ? 0.0002 : 0.0002;             // equal weight - whitespace penalty now handles root normalization waste

// Extents → bounding box margin & background growth
const BBOX_MARGIN = 20;
const BG_EXTRA = 20;

// ---------------- Utilities ----------------
function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function nameSort(a, b) { return String(a.name).localeCompare(String(b.name)); }

function calculateNodeDepth(node, depth = 0) {
  // Recursively calculate depth from root
  // Roots have depth 0, their children have depth 1, etc.
  node._depth = depth;
  for (const child of node.children) {
    calculateNodeDepth(child, depth + 1);
  }
}

function makeNode(id, name, levelIdx) {
  return {
    id,
    name,
    levelIdx,               // 5..1 (5 = most general)
    children: [],
    apps: [],
    width: 0, height: 0,
    x: 0, y: 0,
    // layout decisions captured during search
    _leafCols: null,        // chosen pill columns
    _childCols: null,       // chosen child columns
    _colAssignments: null   // array of columns, each = [childIdx,...]
  };
}

// Cost function to choose between layouts
// Penalizes both area and wasted whitespace
function layoutCost(width, height, contentWidth = null, contentHeight = null, predictedFinalWidth = null) {
  const area = width * height;

  // If this node will be expanded to a predicted width (e.g., root width normalization),
  // calculate waste based on the final expanded dimensions
  let finalWidth = width;
  let finalArea = area;
  if (predictedFinalWidth !== null && predictedFinalWidth > width) {
    finalWidth = predictedFinalWidth;
    finalArea = finalWidth * height;
  }

  // Whitespace penalty: penalize unused space (including expansion waste)
  let whitespaceComponent = 0;
  if (WHITESPACE_PENALTY > 0 && contentWidth !== null && contentHeight !== null) {
    const contentArea = contentWidth * contentHeight;
    const wastedArea = Math.max(0, finalArea - contentArea);
    whitespaceComponent = WHITESPACE_PENALTY * wastedArea;
  }

  // Aspect ratio penalty (based on final dimensions if expanded)
  let aspectComponent = 0;
  if (TARGET_RATIO !== null && ASPECT_W > 0) {
    const ratio = finalWidth / Math.max(1, height);
    const aspectPenalty = (ratio - TARGET_RATIO) * (ratio - TARGET_RATIO);
    aspectComponent = ASPECT_W * finalArea * aspectPenalty;
  }

  return finalArea + whitespaceComponent + aspectComponent;
}

// Improved column assignment that minimizes whitespace in the container
// Tests all possible permutations to find the best layout (not just LPT)
function assignChildrenToColumns(children, cols, vGap = CHILD_V_GAP) {
  if (children.length === 0) {
    return {
      colItems: Array.from({ length: cols }, () => []),
      colHeights: Array(cols).fill(0),
      colMaxW: Array(cols).fill(0),
      innerWidth: 0,
      innerHeight: 0
    };
  }

  // For small child counts, try all reasonable orderings to minimize container whitespace
  // Otherwise use greedy LPT
  const useExhaustiveSearch = children.length <= 10;

  let bestLayout = null;
  let bestWaste = Infinity;

  if (useExhaustiveSearch) {
    // Try multiple heuristic orderings and pick the one with least whitespace
    const orderings = [
      // LPT: tallest first
      children.map((ch, idx) => ({ idx, h: ch.height, w: ch.width }))
        .sort((a, b) => b.h - a.h),
      // Reverse LPT: shortest first
      children.map((ch, idx) => ({ idx, h: ch.height, w: ch.width }))
        .sort((a, b) => a.h - b.h),
      // By width (widest first)
      children.map((ch, idx) => ({ idx, h: ch.height, w: ch.width }))
        .sort((a, b) => b.w - a.w),
      // By area (largest first)
      children.map((ch, idx) => ({ idx, h: ch.height, w: ch.width, a: ch.height * ch.width }))
        .sort((a, b) => b.a - a.a),
    ];

    for (const ordering of orderings) {
      const layout = assignChildrenToColumnsGreedy(ordering, cols, children, vGap);
      const waste = layout.innerWidth * layout.innerHeight * (1 - getContentArea(layout, children) / (layout.innerWidth * layout.innerHeight));

      if (waste < bestWaste) {
        bestWaste = waste;
        bestLayout = layout;
      }
    }
  } else {
    // For many children, just use LPT
    const order = children
      .map((ch, idx) => ({ idx, h: ch.height, w: ch.width }))
      .sort((a, b) => b.h - a.h);
    bestLayout = assignChildrenToColumnsGreedy(order, cols, children, vGap);
  }

  return bestLayout;
}

// Helper: greedy assignment given a specific ordering
function assignChildrenToColumnsGreedy(order, cols, children, vGap) {
  const colHeights = Array(cols).fill(0);
  const colMaxW    = Array(cols).fill(0);
  const colItems   = Array.from({ length: cols }, () => []);

  for (const { idx } of order) {
    const { height: h, width: w } = children[idx];

    // Choose column with smallest current height
    let bestC = 0;
    let bestH = colHeights[0];
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < bestH) {
        bestH = colHeights[c];
        bestC = c;
      }
    }

    // Place child into best column
    colItems[bestC].push(idx);

    // Update height (+ gap if not first)
    if (colHeights[bestC] > 0) {
      colHeights[bestC] += vGap;
    }
    colHeights[bestC] += h;

    // Update max width
    colMaxW[bestC] = Math.max(colMaxW[bestC], w);
  }

  // Overall inner width and height
  const innerWidth = colMaxW.reduce((a, b) => a + b, 0) + (cols - 1) * CHILD_H_GAP;
  const innerHeight = Math.max(...colHeights, 0);

  return { colItems, colHeights, colMaxW, innerWidth, innerHeight };
}

// Helper: calculate actual content area used in layout
function getContentArea(layout, children) {
  let totalArea = 0;
  const { colItems } = layout;

  for (let c = 0; c < colItems.length; c++) {
    const indices = colItems[c];
    let colArea = 0;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      colArea += children[idx].width * children[idx].height;
      if (i > 0) colArea += CHILD_V_GAP * children[idx].width; // gap area
    }
    totalArea += colArea;
  }

  // Add inter-column gaps
  if (colItems.length > 1) {
    const totalHeight = Math.max(...colItems.map((col, c) => {
      let h = 0;
      for (const idx of col) {
        h += children[idx].height;
        if (col.indexOf(idx) > 0) h += CHILD_V_GAP;
      }
      return h;
    }));
    totalArea += (colItems.length - 1) * CHILD_H_GAP * totalHeight;
  }

  return totalArea;
}

// ============================================================================
// 2D BIN PACKING: MaxRects Algorithm with BSSF (Best Short Side Fit)
// ============================================================================

// MaxRects 2D packing for logical children (non-leaf nodes)
// Returns placements with (x, y) coordinates for each child
function layout2DMaxRects(children, maxWidth, hGap = CHILD_H_GAP, vGap = CHILD_V_GAP, heuristic = 'BSSF', sortStrategy = 'area') {
  if (children.length === 0) {
    return { placements: [], width: 0, height: 0 };
  }

  // Choose sort function based on strategy
  let sortFn;
  switch (sortStrategy) {
    case 'area':
      sortFn = (a, b) => (b.width * b.height) - (a.width * a.height);
      break;
    case 'height':
      sortFn = (a, b) => b.height - a.height;
      break;
    case 'width':
      sortFn = (a, b) => b.width - a.width;
      break;
    case 'perimeter':
      sortFn = (a, b) => ((b.width + b.height) - (a.width + a.height));
      break;
    case 'aspectRatioWH':
      sortFn = (a, b) => (b.width / b.height) - (a.width / a.height);
      break;
    case 'aspectRatioHW':
      sortFn = (a, b) => (b.height / b.width) - (a.height / a.width);
      break;
    default:
      sortFn = (a, b) => (b.width * b.height) - (a.width * a.height); // Default to area
  }

  // Sort by chosen strategy
  const sorted = children
    .map((ch, idx) => ({
      idx,
      width: ch.width,
      height: ch.height,
      child: ch
    }))
    .sort(sortFn);

  // Initialize free rectangles with the full container
  const freeRects = [{ x: 0, y: 0, width: maxWidth, height: 999999 }];
  const placements = [];
  const occupiedRects = []; // Track all occupied space for validation

  for (const item of sorted) {
    // Reserve space for item + gap on right and bottom
    const reservedWidth = item.width + hGap;
    const reservedHeight = item.height + vGap;

    // Find best position using specified heuristic (for reserved space)
    const placement = findPositionWithHeuristic(freeRects, reservedWidth, reservedHeight, heuristic, occupiedRects);

    if (!placement) {
      // Fallback: stack vertically if can't fit
      const fallbackY = occupiedRects.length > 0
        ? Math.max(...occupiedRects.map(r => r.y + r.height))
        : 0;

      const newPlacement = {
        idx: item.idx,
        x: 0,
        y: fallbackY,
        width: item.width,
        height: item.height
      };

      placements.push(newPlacement);
      occupiedRects.push({
        x: 0,
        y: fallbackY,
        width: reservedWidth,
        height: reservedHeight
      });
      continue;
    }

    // Validate no overlap with existing placements
    const newOccupied = {
      x: placement.x,
      y: placement.y,
      width: reservedWidth,
      height: reservedHeight
    };

    // Check for overlaps (shouldn't happen, but safety check)
    let hasOverlap = false;
    for (const occupied of occupiedRects) {
      if (rectanglesOverlap(occupied, newOccupied)) {
        hasOverlap = true;
        break;
      }
    }

    if (hasOverlap) {
      // Safety: use fallback if overlap detected
      const fallbackY = occupiedRects.length > 0
        ? Math.max(...occupiedRects.map(r => r.y + r.height))
        : 0;

      placements.push({
        idx: item.idx,
        x: 0,
        y: fallbackY,
        width: item.width,
        height: item.height
      });

      occupiedRects.push({
        x: 0,
        y: fallbackY,
        width: reservedWidth,
        height: reservedHeight
      });
    } else {
      // Store placement (actual item dimensions at this position)
      placements.push({
        idx: item.idx,
        x: placement.x,
        y: placement.y,
        width: item.width,
        height: item.height
      });

      // Track occupied space (including gap)
      occupiedRects.push(newOccupied);

      // Update free rectangles after placing this item (reserve space including gap)
      updateFreeRectangles(freeRects, placement.x, placement.y, reservedWidth, reservedHeight);
    }
  }

  // Calculate final container dimensions (including all items and gaps)
  let usedWidth = 0;
  let usedHeight = 0;

  if (placements.length > 0) {
    // Find rightmost and bottommost extents
    for (const p of placements) {
      usedWidth = Math.max(usedWidth, p.x + p.width);
      usedHeight = Math.max(usedHeight, p.y + p.height);
    }
  }

  return {
    placements: placements,
    width: usedWidth,
    height: usedHeight
  };
}

// Multi-strategy exhaustive search (for small nodes ≤8 children)
// Tries all combinations of heuristics × sort strategies
function layout2DMultiStrategy(children, maxWidth, hGap = CHILD_H_GAP, vGap = CHILD_V_GAP) {
  const heuristics = ['BSSF', 'BLSF', 'BAF', 'BL', 'CP'];
  const sortStrategies = ['area', 'height', 'width', 'perimeter', 'aspectRatioWH', 'aspectRatioHW'];

  let bestPacking = null;
  let bestWaste = Infinity;

  for (const heuristic of heuristics) {
    for (const sortStrategy of sortStrategies) {
      const packing = layout2DMaxRects(children, maxWidth, hGap, vGap, heuristic, sortStrategy);
      const waste = packing.width * packing.height - children.reduce((sum, ch) => sum + ch.width * ch.height, 0);

      if (waste < bestWaste) {
        bestWaste = waste;
        bestPacking = packing;
      }
    }
  }

  return bestPacking;
}

// Genetic Algorithm for 2D packing (for large nodes ≥16 children)
function layout2DGenetic(children, maxWidth, hGap = CHILD_H_GAP, vGap = CHILD_V_GAP) {
  const populationSize = 25;
  const maxGenerations = 60;
  const mutationRate = 0.3;
  const noImprovementLimit = 10;

  const heuristics = ['BSSF', 'BLSF', 'BAF', 'BL', 'CP'];
  const sortStrategies = ['area', 'height', 'width', 'perimeter', 'aspectRatioWH', 'aspectRatioHW'];

  // Initialize population
  let population = [];
  for (let i = 0; i < populationSize; i++) {
    population.push({
      heuristic: heuristics[Math.floor(Math.random() * heuristics.length)],
      sortStrategy: sortStrategies[Math.floor(Math.random() * sortStrategies.length)],
      shuffle: Math.random() > 0.7 // 30% chance to shuffle order
    });
  }

  let bestEver = null;
  let bestEverFitness = -Infinity;
  let generationsWithoutImprovement = 0;

  for (let gen = 0; gen < maxGenerations; gen++) {
    // Evaluate fitness for each chromosome
    const evaluated = population.map(chromo => {
      const packing = layout2DMaxRects(children, maxWidth, hGap, vGap, chromo.heuristic, chromo.sortStrategy);
      const area = packing.width * packing.height;
      const contentArea = children.reduce((sum, ch) => sum + ch.width * ch.height, 0);
      const fitness = contentArea / (area + 1); // Higher is better (less waste)

      return { chromo, packing, fitness };
    });

    // Sort by fitness
    evaluated.sort((a, b) => b.fitness - a.fitness);

    // Track best
    if (evaluated[0].fitness > bestEverFitness) {
      bestEverFitness = evaluated[0].fitness;
      bestEver = evaluated[0].packing;
      generationsWithoutImprovement = 0;
    } else {
      generationsWithoutImprovement++;
    }

    // Early stopping only if we've exhausted search space AND hit plateau
    // Since we have limited chromosome space (5 heuristics × 6 sorts = 30 combinations),
    // we need to run longer to properly explore through mutations and crossover
    if (generationsWithoutImprovement >= noImprovementLimit && gen > maxGenerations * 0.6) {
      break;
    }

    // Selection: keep top 50%
    const survivors = evaluated.slice(0, Math.ceil(populationSize / 2));

    // Create next generation
    const nextGen = survivors.map(s => s.chromo); // Keep survivors

    // Crossover and mutation to fill remaining slots
    while (nextGen.length < populationSize) {
      const parent1 = survivors[Math.floor(Math.random() * survivors.length)].chromo;
      const parent2 = survivors[Math.floor(Math.random() * survivors.length)].chromo;

      const child = {
        heuristic: Math.random() < 0.5 ? parent1.heuristic : parent2.heuristic,
        sortStrategy: Math.random() < 0.5 ? parent1.sortStrategy : parent2.sortStrategy,
        shuffle: Math.random() < 0.5 ? parent1.shuffle : parent2.shuffle
      };

      // Mutation
      if (Math.random() < mutationRate) {
        child.heuristic = heuristics[Math.floor(Math.random() * heuristics.length)];
      }
      if (Math.random() < mutationRate) {
        child.sortStrategy = sortStrategies[Math.floor(Math.random() * sortStrategies.length)];
      }

      nextGen.push(child);
    }

    population = nextGen;
  }

  return bestEver || layout2DMaxRects(children, maxWidth, hGap, vGap, 'BSSF', 'area');
}

// Beam Search for 2D packing (for medium nodes 9-15 children)
function layout2DBeamSearch(children, maxWidth, hGap = CHILD_H_GAP, vGap = CHILD_V_GAP, beamWidth = 8) {
  if (children.length === 0) {
    return { placements: [], width: 0, height: 0 };
  }

  const heuristics = ['BSSF', 'BLSF', 'BAF'];

  // Initialize beam with top heuristic-based partial solutions
  let beam = [];

  for (const heuristic of heuristics) {
    const packing = layout2DMaxRects(children, maxWidth, hGap, vGap, heuristic, 'area');
    const waste = packing.width * packing.height - children.reduce((sum, ch) => sum + ch.width * ch.height, 0);
    beam.push({ packing, waste });
  }

  // Try different sort strategies on best heuristics
  const sortStrategies = ['height', 'width', 'perimeter', 'aspectRatioWH', 'aspectRatioHW'];
  for (const heuristic of heuristics) {
    for (const sortStrategy of sortStrategies) {
      const packing = layout2DMaxRects(children, maxWidth, hGap, vGap, heuristic, sortStrategy);
      const waste = packing.width * packing.height - children.reduce((sum, ch) => sum + ch.width * ch.height, 0);
      beam.push({ packing, waste });
    }
  }

  // Sort beam by waste and keep top beamWidth
  beam.sort((a, b) => a.waste - b.waste);
  beam = beam.slice(0, beamWidth);

  // Return best from beam
  return beam[0].packing;
}

// Check if two rectangles overlap (including edges touching)
function rectanglesOverlap(r1, r2) {
  return !(r1.x >= r2.x + r2.width ||
           r1.x + r1.width <= r2.x ||
           r1.y >= r2.y + r2.height ||
           r1.y + r1.height <= r2.y);
}

// Find best position using specified heuristic
// Heuristics: 'BSSF', 'BLSF', 'BAF', 'BL', 'CP'
function findPositionWithHeuristic(freeRects, itemWidth, itemHeight, heuristic = 'BSSF', occupiedRects = []) {
  let bestRect = null;
  let bestScore = Infinity;
  let bestSecondaryScore = Infinity;

  for (const rect of freeRects) {
    // Check if item fits in this rectangle
    if (rect.width >= itemWidth && rect.height >= itemHeight) {
      const leftoverHoriz = rect.width - itemWidth;
      const leftoverVert = rect.height - itemHeight;
      const leftoverArea = leftoverHoriz * leftoverVert +
                          (rect.width - itemWidth) * itemHeight +
                          itemWidth * (rect.height - itemHeight);

      let score, secondaryScore;

      switch (heuristic) {
        case 'BSSF': // Best Short Side Fit
          score = Math.min(leftoverHoriz, leftoverVert);
          secondaryScore = Math.max(leftoverHoriz, leftoverVert);
          break;

        case 'BLSF': // Best Long Side Fit
          score = Math.max(leftoverHoriz, leftoverVert);
          secondaryScore = Math.min(leftoverHoriz, leftoverVert);
          break;

        case 'BAF': // Best Area Fit
          score = leftoverArea;
          secondaryScore = Math.min(leftoverHoriz, leftoverVert);
          break;

        case 'BL': // Bottom-Left (prefer lowest y, then leftmost x)
          score = rect.y;
          secondaryScore = rect.x;
          break;

        case 'CP': // Contact Point (maximize perimeter touching existing items)
          const contactScore = calculateContactPerimeter(rect.x, rect.y, itemWidth, itemHeight, occupiedRects);
          score = -contactScore; // Negative because we want to maximize contact
          secondaryScore = Math.min(leftoverHoriz, leftoverVert);
          break;

        default:
          score = Math.min(leftoverHoriz, leftoverVert); // Default to BSSF
          secondaryScore = Math.max(leftoverHoriz, leftoverVert);
      }

      // Pick best based on primary score, break ties with secondary
      if (score < bestScore || (score === bestScore && secondaryScore < bestSecondaryScore)) {
        bestRect = rect;
        bestScore = score;
        bestSecondaryScore = secondaryScore;
      }
    }
  }

  if (!bestRect) return null;

  return {
    x: bestRect.x,
    y: bestRect.y,
    width: itemWidth,
    height: itemHeight
  };
}

// Calculate perimeter in contact with already-placed items
function calculateContactPerimeter(x, y, width, height, occupiedRects) {
  let contact = 0;
  const right = x + width;
  const bottom = y + height;

  for (const occupied of occupiedRects) {
    const occRight = occupied.x + occupied.width;
    const occBottom = occupied.y + occupied.height;

    // Check left edge contact
    if (Math.abs(x - occRight) < 0.1 && rangesOverlap(y, bottom, occupied.y, occBottom)) {
      contact += Math.min(bottom, occBottom) - Math.max(y, occupied.y);
    }

    // Check right edge contact
    if (Math.abs(right - occupied.x) < 0.1 && rangesOverlap(y, bottom, occupied.y, occBottom)) {
      contact += Math.min(bottom, occBottom) - Math.max(y, occupied.y);
    }

    // Check top edge contact
    if (Math.abs(y - occBottom) < 0.1 && rangesOverlap(x, right, occupied.x, occRight)) {
      contact += Math.min(right, occRight) - Math.max(x, occupied.x);
    }

    // Check bottom edge contact
    if (Math.abs(bottom - occupied.y) < 0.1 && rangesOverlap(x, right, occupied.x, occRight)) {
      contact += Math.min(right, occRight) - Math.max(x, occupied.x);
    }
  }

  return contact;
}

// Check if two 1D ranges overlap
function rangesOverlap(a1, a2, b1, b2) {
  return Math.max(a1, b1) < Math.min(a2, b2);
}

// Legacy wrapper for backward compatibility
function findPositionBSSF(freeRects, itemWidth, itemHeight) {
  return findPositionWithHeuristic(freeRects, itemWidth, itemHeight, 'BSSF', []);
}

// Update free rectangles after placing an item
function updateFreeRectangles(freeRects, usedX, usedY, usedWidth, usedHeight) {
  const usedRight = usedX + usedWidth;
  const usedBottom = usedY + usedHeight;

  const newFreeRects = [];

  for (const rect of freeRects) {
    const rectRight = rect.x + rect.width;
    const rectBottom = rect.y + rect.height;

    // Check if this free rectangle intersects with the used space
    if (intersects(rect, usedX, usedY, usedWidth, usedHeight)) {
      // Split this rectangle into up to 4 non-overlapping free rectangles

      // Left side (west of used rect)
      if (rect.x < usedX && rectRight > usedX) {
        newFreeRects.push({
          x: rect.x,
          y: rect.y,
          width: usedX - rect.x,
          height: rect.height
        });
      }

      // Right side (east of used rect)
      if (rect.x < usedRight && rectRight > usedRight) {
        newFreeRects.push({
          x: usedRight,
          y: rect.y,
          width: rectRight - usedRight,
          height: rect.height
        });
      }

      // Top side (north of used rect)
      if (rect.y < usedY && rectBottom > usedY) {
        newFreeRects.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: usedY - rect.y
        });
      }

      // Bottom side (south of used rect)
      if (rect.y < usedBottom && rectBottom > usedBottom) {
        newFreeRects.push({
          x: rect.x,
          y: usedBottom,
          width: rect.width,
          height: rectBottom - usedBottom
        });
      }
    } else {
      // No intersection, keep this free rectangle as-is
      newFreeRects.push(rect);
    }
  }

  // Clear original array and add new rectangles
  freeRects.length = 0;
  freeRects.push(...newFreeRects);

  // Remove rectangles that are fully contained within other rectangles
  pruneContainedRectangles(freeRects);
}

// Check if two rectangles intersect
function intersects(rect, x, y, width, height) {
  return !(rect.x >= x + width ||
           rect.x + rect.width <= x ||
           rect.y >= y + height ||
           rect.y + rect.height <= y);
}

// Remove rectangles that are fully contained within other rectangles
function pruneContainedRectangles(freeRects) {
  for (let i = freeRects.length - 1; i >= 0; i--) {
    for (let j = freeRects.length - 1; j >= 0; j--) {
      if (i !== j && isContainedIn(freeRects[i], freeRects[j])) {
        freeRects.splice(i, 1);
        break;
      }
    }
  }
}

// Check if rectA is fully contained within rectB
function isContainedIn(rectA, rectB) {
  return rectA.x >= rectB.x &&
         rectA.y >= rectB.y &&
         rectA.x + rectA.width <= rectB.x + rectB.width &&
         rectA.y + rectA.height <= rectB.y + rectB.height;
}

// ---------------- Ingest & Build Hierarchy ----------------
let rows = [];
if (items.length === 1 && Array.isArray(items[0].json?.data)) {
  rows = items[0].json.data;
} else {
  rows = items.map(i => i.json);
}

const nodesById = new Map();
const hasParent = new Set();

function getOrCreateNode(id, name, levelIdx) {
  if (!nodesById.has(id)) {
    nodesById.set(id, makeNode(id, name, levelIdx));
  }
  const n = nodesById.get(id);
  if (name && !n.name) n.name = name;
  if (typeof levelIdx === "number") n.levelIdx = levelIdx;
  return n;
}

// Build paths Level5..Level1 → parent/child; attach apps to most-specific
for (const r of rows) {
  const path = [];
  for (let lvl = 5; lvl >= 1; lvl--) {
    const name = r[`LogicalLevel${lvl}`];
    const id   = r[`LogicalID${lvl}`];
    if (name && id) path.push({ id, name, levelIdx: lvl });
  }
  if (path.length === 0) continue;

  for (let i = 0; i < path.length; i++) {
    const { id, name, levelIdx } = path[i];
    const node = getOrCreateNode(id, name, levelIdx);
    if (i > 0) {
      const parentInfo = path[i - 1];
      const parent = getOrCreateNode(parentInfo.id, parentInfo.name, parentInfo.levelIdx);
      if (!parent.children.find(c => c.id === node.id)) parent.children.push(node);
      hasParent.add(node.id);
    }
  }

  const leafInfo = path[path.length - 1];
  const leaf = getOrCreateNode(leafInfo.id, leafInfo.name, leafInfo.levelIdx);
  leaf.apps.push({
    id: r.PhysicalAppID || slugify(r.PhysicalApplication || "app"),
    name: r.PhysicalApplication || ""
  });
}

// Roots = nodes without parents
let roots = [...nodesById.values()].filter(n => !hasParent.has(n.id));

// Priority order for named roots
const ROOT_PRIORITY = [
  "Core Business Systems",
  "Corporate Systems",
  "Enabling Systems",
];

function rootOrderKey(n) {
  const pIndex = ROOT_PRIORITY.findIndex(name => name.toLowerCase() === String(n.name).toLowerCase());
  return pIndex === -1 ? 999 : pIndex;
}

roots.sort((a, b) => {
  const pa = rootOrderKey(a), pb = rootOrderKey(b);
  if (pa !== pb) return pa - pb;
  return nameSort(a, b);
});
(function sortTree(nodes){
  for (const n of nodes) {
    if (SORT_LOGICAL_AZ) n.children.sort(nameSort);
    sortTree(n.children);
  }
})(roots);

// Calculate depth for each node (0 for roots, 1 for children, 2 for grandchildren, etc.)
// This is used for alternating background colors in the visual hierarchy
roots.forEach(root => calculateNodeDepth(root, 0));

// ---------------- Layout: optimise per node ----------------
function sizeLeafOptimised(node) {
  const apps = SORT_PHYSICAL_AZ ? node.apps.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))) : node.apps;

  // Try columns 1..PILL_MAX_COLS and pick best cost
  let best = null;

  for (let cols = 1; cols <= Math.min(PILL_MAX_COLS, Math.max(1, apps.length)); cols++) {
    const rowsNeeded = Math.max(1, Math.ceil(apps.length / cols));
    const innerW = PILL_WIDTH + (cols - 1) * PILL_COL_STEP;
    const contentH = apps.length === 0 ? 0 : (PILL_HEIGHT + (rowsNeeded - 1) * PILL_ROW_STEP);

    const width  = Math.max(MIN_LOGICAL_WIDTH, LA_PAD_X * 2 + innerW);
    const height = LA_PAD_TOP + contentH + LA_PAD_BOTTOM;

    // Pass content dimensions for whitespace penalty calculation
    const contentWidth = LA_PAD_X * 2 + innerW;
    const contentHeight = LA_PAD_TOP + contentH + LA_PAD_BOTTOM;
    const cost = layoutCost(width, height, contentWidth, contentHeight);

    if (!best || cost < best.cost) {
      best = { width, height, cols, cost };
    }
  }

  node.width    = best.width;
  node.height   = best.height;
  node._leafCols = best.cols;
}

// Special-case optimization for 1-2 children nodes
// Tests exhaustive layouts (horizontal/vertical) to find mathematically optimal packing
function sizeSmallNodeOptimal(node, isRoot = false) {
  if (node.children.length === 0 || node.children.length > 2) {
    // This function only handles 1-2 children
    return false;
  }

  const child = node.children[0];
  let best = null;
  const predictedWidth = isRoot ? PREDICTED_ROOT_WIDTH : null;

  if (node.children.length === 1) {
    // Single child: width = child.width + padding, height = child.height + padding
    const width = Math.max(MIN_LOGICAL_WIDTH, child.width + LA_PAD_X * 2);
    const height = child.height + LA_PAD_TOP + LA_PAD_BOTTOM;
    const cost = layoutCost(width, height, child.width + LA_PAD_X * 2, child.height + LA_PAD_TOP + LA_PAD_BOTTOM, predictedWidth);
    // Placements are relative to inner area (after padding), so x=0, y=0
    best = { width, height, placements: [{ idx: 0, x: 0, y: 0, width: child.width, height: child.height }], cost };
  } else {
    // Two children: test horizontal and vertical layouts
    const child1 = node.children[0];
    const child2 = node.children[1];

    // LAYOUT 1: Horizontal (side-by-side)
    const horizWidth = child1.width + CHILD_H_GAP + child2.width + LA_PAD_X * 2;
    const horizHeight = Math.max(child1.height, child2.height) + LA_PAD_TOP + LA_PAD_BOTTOM;
    // Content dimensions: tight bounding box of children (excluding padding, including gaps)
    const horizContentWidth = child1.width + CHILD_H_GAP + child2.width;
    const horizContentHeight = Math.max(child1.height, child2.height);
    const horizCost = layoutCost(horizWidth, horizHeight, horizContentWidth + LA_PAD_X * 2, horizContentHeight + LA_PAD_TOP + LA_PAD_BOTTOM, predictedWidth);

    best = {
      width: Math.max(MIN_LOGICAL_WIDTH, horizWidth),
      height: horizHeight,
      placements: [
        // Positions relative to inner area (0,0 = top-left after padding)
        { idx: 0, x: 0, y: 0, width: child1.width, height: child1.height },
        { idx: 1, x: child1.width + CHILD_H_GAP, y: 0, width: child2.width, height: child2.height }
      ],
      cost: horizCost
    };

    // LAYOUT 2: Vertical (stacked)
    const vertWidth = Math.max(child1.width, child2.width) + LA_PAD_X * 2;
    const vertHeight = child1.height + CHILD_V_GAP + child2.height + LA_PAD_TOP + LA_PAD_BOTTOM;
    // Content dimensions: tight bounding box of children (excluding padding, including gaps)
    const vertContentWidth = Math.max(child1.width, child2.width);
    const vertContentHeight = child1.height + CHILD_V_GAP + child2.height;
    const vertCost = layoutCost(vertWidth, vertHeight, vertContentWidth + LA_PAD_X * 2, vertContentHeight + LA_PAD_TOP + LA_PAD_BOTTOM, predictedWidth);

    if (vertCost < best.cost) {
      best = {
        width: Math.max(MIN_LOGICAL_WIDTH, vertWidth),
        height: vertHeight,
        placements: [
          // Positions relative to inner area (0,0 = top-left after padding)
          { idx: 0, x: 0, y: 0, width: child1.width, height: child1.height },
          { idx: 1, x: 0, y: child1.height + CHILD_V_GAP, width: child2.width, height: child2.height }
        ],
        cost: vertCost
      };
    }
  }

  // Set node dimensions and placements
  node.width = best.width;
  node.height = best.height;
  node._use2D = true;
  node._2DPlacements = best.placements;
  return true;
}

function sizeNonLeafOptimised(node, isRoot = false) {
  // size children first (they carry their own optimised sizes)
  // Note: children are never roots
  node.children.forEach(child => sizeNodeOptimised(child, false));

  if (node.children.length === 0) {
    node.width = MIN_LOGICAL_WIDTH;
    node.height = LA_PAD_TOP + LA_PAD_BOTTOM;
    node._use2D = false;
    return;
  }

  // ADAPTIVE DISPATCHER: Choose packing strategy based on node complexity
  const childCount = node.children.length;

  // TIER 0: Special case for 1-2 children - exhaustive optimal packing
  if (childCount <= 2) {
    sizeSmallNodeOptimal(node, isRoot);
    return;
  }

  let best = null;

  // Calculate reasonable width range to test
  const minWidth = Math.max(
    MIN_LOGICAL_WIDTH,
    Math.max(...node.children.map(ch => ch.width)) + LA_PAD_X * 2
  );
  const maxWidth = node.children.reduce((sum, ch) => sum + ch.width, 0) + LA_PAD_X * 2;

  // Test 5 different widths between min and max
  const widthsToTest = [];
  for (let i = 0; i < 5; i++) {
    const testWidth = minWidth + (maxWidth - minWidth) * (i / 4);
    widthsToTest.push(Math.ceil(testWidth));
  }

  for (const testWidth of widthsToTest) {
    const innerWidth = testWidth - LA_PAD_X * 2;
    let packing;

    // Choose strategy based on child count
    if (childCount <= 8) {
      // TIER 1: Multi-Strategy Exhaustive (30 attempts)
      // Fast for small nodes, excellent results
      packing = layout2DMultiStrategy(node.children, innerWidth, CHILD_H_GAP, CHILD_V_GAP);
    } else if (childCount <= 15) {
      // TIER 2: Beam Search (K=12)
      // Balanced approach for medium nodes - increased beam width for better quality
      packing = layout2DBeamSearch(node.children, innerWidth, CHILD_H_GAP, CHILD_V_GAP, 12);
    } else {
      // TIER 3: Fast Genetic Algorithm
      // Maximum quality for complex nodes
      packing = layout2DGenetic(node.children, innerWidth, CHILD_H_GAP, CHILD_V_GAP);
    }

    const width = Math.max(MIN_LOGICAL_WIDTH, LA_PAD_X * 2 + packing.width);
    const height = LA_PAD_TOP + packing.height + LA_PAD_BOTTOM;

    // Calculate cost with whitespace penalty (and predicted width for root nodes)
    const contentWidth = LA_PAD_X * 2 + packing.width;
    const contentHeight = LA_PAD_TOP + packing.height + LA_PAD_BOTTOM;
    const predictedWidth = isRoot ? PREDICTED_ROOT_WIDTH : null;
    const cost = layoutCost(width, height, contentWidth, contentHeight, predictedWidth);

    if (!best || cost < best.cost) {
      best = {
        width,
        height,
        cost,
        placements: packing.placements,
        innerWidth: packing.width,
        innerHeight: packing.height
      };
    }
  }

  node.width = best.width;
  node.height = best.height;
  node._use2D = true;
  node._2DPlacements = best.placements; // Store 2D positions
}

function sizeNodeOptimised(node, isRoot = false) {
  if (node.children.length === 0) {
    sizeLeafOptimised(node);
  } else {
    sizeNonLeafOptimised(node, isRoot);
  }

  // In compact mode, only nudge aspect ratio if ratio is very far from target
  // This prevents unnecessary padding just to hit the golden ratio
  if (!COMPACT_MODE) {
    const ratio = node.width / node.height;
    if (ratio < TARGET_RATIO) {
      const targetW = Math.ceil(node.height * TARGET_RATIO);
      node.width = Math.max(node.width, targetW);
    } else if (ratio > TARGET_RATIO) {
      const targetH = Math.ceil(node.width / TARGET_RATIO);
      node.height = Math.max(node.height, targetH);
    }
  }
  // In compact mode, skip aspect ratio adjustment for smaller containers
  // Only nudge very large containers that benefit from better proportions
}

// TWO-PASS SIZING for root width normalization awareness
// Pass 1: Size all roots normally to get their natural widths
let PREDICTED_ROOT_WIDTH = MIN_LOGICAL_WIDTH;
roots.forEach(root => sizeNodeOptimised(root, false));

// Calculate the actual max root width from first pass
const maxRootWidthPass1 = roots.reduce((m, n) => Math.max(m, n.width), 0);
PREDICTED_ROOT_WIDTH = maxRootWidthPass1;

// Pass 2: Re-size all roots with knowledge of the final normalized width
// This allows cost function to optimize for post-normalization layout
roots.forEach(root => sizeNodeOptimised(root, true));

// Make all root widths equal (max) for visual alignment
// This ensures Core Business Systems, Corporate Systems, Enabling Systems, and Technologies
// all have the same width for a cleaner, more organized layout
const maxRootWidth = roots.reduce((m, n) => Math.max(m, n.width), 0);
roots.forEach(n => { n.width = maxRootWidth; });

// ---------------- Placement ----------------
const boxes = [];

function placeLeaf(node, innerX, innerY) {
  const apps = SORT_PHYSICAL_AZ ? node.apps.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))) : node.apps;
  const cols = Math.min(node._leafCols || 1, Math.max(1, apps.length));

  apps.forEach((app, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const px = innerX + c * PILL_COL_STEP;
    const py = innerY + r * PILL_ROW_STEP;
    boxes.push({
      id: `app-${slugify(node.id)}-${slugify(app.id)}-${slugify(app.name)}`,
      stencil: STENCIL_PHYSICAL,
      x: px,
      y: py,
      bodyText: app.name,
      headerText: ""
    });
  });
}

function placeNonLeaf(node, innerX, innerY) {
  // Check if this node uses 2D packing or column-based layout
  if (node._use2D && node._2DPlacements) {
    // Use 2D MaxRects placements
    for (const placement of node._2DPlacements) {
      const child = node.children[placement.idx];
      const childX = innerX + placement.x;
      const childY = innerY + placement.y;
      placeNode(child, childX, childY);
    }
  } else {
    // Fallback to column-based layout (for backward compatibility)
    const cols = node._childCols || Math.min(CHILD_MAX_COLS, Math.max(1, node.children.length));
    const assignments = node._colAssignments || [];

    // compute x per column using measured child widths
    const colWidths = Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      const indices = assignments[c] || [];
      let maxW = 0;
      for (const idx of indices) {
        maxW = Math.max(maxW, node.children[idx].width);
      }
      colWidths[c] = maxW;
    }

    const colX = [];
    let accX = innerX;
    for (let c = 0; c < cols; c++) {
      colX[c] = accX;
      accX += colWidths[c] + (c < cols - 1 ? CHILD_H_GAP : 0);
    }

    // place per column, stacked with CHILD_V_GAP
    for (let c = 0; c < cols; c++) {
      const indices = assignments[c] || [];
      let y = innerY;
      indices.forEach((idx, i) => {
        const child = node.children[idx];
        placeNode(child, colX[c], y);
        y += child.height + CHILD_V_GAP;
      });
    }
  }
}

function placeNode(node, x, y) {
  node.x = x; node.y = y;

  // logical container (headerText only)
  const logicalBox = {
    id: `grp-${slugify(node.id)}-${slugify(node.name)}`,
    stencil: STENCIL_LOGICAL,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    headerText: node.name,
    bodyText: ""
  };

  // Add alternating background colors based on depth in hierarchy
  // Odd depths get white background, even depths get default (no explicit background)
  if (node._depth !== undefined && node._depth % 2 === 1) {
    logicalBox.backgroundColor = "#FFFFFF";
  }

  boxes.push(logicalBox);

  const innerX = node.x + LA_PAD_X;
  const innerY = node.y + LA_PAD_TOP;

  if (node.children.length === 0) {
    placeLeaf(node, innerX, innerY);
  } else {
    placeNonLeaf(node, innerX, innerY);
  }
}

// Place roots as a single column in the requested priority order
let canvasY = PAGE_TOP;
for (const root of roots) {
  placeNode(root, PAGE_LEFT, canvasY);
  canvasY += root.height + ROOT_V_GAP;
}

// ---------------- Bounding & Background ----------------
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const b of boxes) {
  if (b.stencil !== STENCIL_LOGICAL) continue;
  const bx = b.x, by = b.y, bw = b.width || 0, bh = b.height || 0;
  minX = Math.min(minX, bx);
  minY = Math.min(minY, by);
  maxX = Math.max(maxX, bx + bw);
  maxY = Math.max(maxY, by + bh);
}
if (!isFinite(minX)) { // fallback if no logical boxes
  minX = PAGE_LEFT; minY = PAGE_TOP; maxX = PAGE_LEFT + 1000; maxY = PAGE_TOP + 600;
}

// margin → base bbox
minX -= BBOX_MARGIN; minY -= BBOX_MARGIN;
maxX += BBOX_MARGIN; maxY += BBOX_MARGIN;

let bboxX = minX, bboxY = minY;
let bboxW = maxX - minX, bboxH = maxY - minY;

// In compact mode with equal root widths, we don't enforce aspect ratio on the bounding box
// This allows the diagram to size naturally to the content without artificial padding
// (aspect ratio enforcement is disabled when TARGET_RATIO is null)

// background 20 px larger on each edge than bounding box
const bgX = bboxX - BG_EXTRA;
const bgY = bboxY - BG_EXTRA;
const bgW = bboxW + BG_EXTRA * 2;
const bgH = bboxH + BG_EXTRA * 2;

// Add 60px page margin so background doesn't touch page edge
const PAGE_MARGIN = 60;
const shiftX = PAGE_MARGIN - bgX;  // How much to shift everything right
const shiftY = PAGE_MARGIN - bgY;  // How much to shift everything down

const background = {
  id: "bg1",
  stencil: STENCIL_BG,
  x: bgX + shiftX,
  y: bgY + shiftY,
  width: bgW,
  height: bgH
};

const bounding = {
  id: "bbox1",
  stencil: STENCIL_BBOX,
  x: bboxX + shiftX,
  y: bboxY + shiftY,
  width: bboxW,
  height: bboxH
};

// Shift all content boxes by the same amount
const shiftedBoxes = boxes.map(box => ({
  ...box,
  x: box.x + shiftX,
  y: box.y + shiftY
}));

// Z-order: background, bounding box, then content
const finalBoxes = [background, bounding, ...shiftedBoxes];

// Emit diagram as JSON string
const diagram = { id: DIAGRAM_ID, title: DIAGRAM_TITLE, boxes: finalBoxes };
return [{ json: { diagram: JSON.stringify(diagram, null, 2) } }];
