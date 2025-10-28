# Hierarchical Layout Optimisation Algorithm Specification

## Overview

This algorithm automatically generates compact, aesthetically balanced layouts for complex hierarchical diagrams that represent *logical and physical applications*. It is designed to minimise whitespace, maintain structural clarity, and respect established stencil conventions (e.g., “logicalApplication”, “physicalApplication”).  

The output is a single JSON diagram object, suitable for direct import into visual renderers such as Renoir, with stencils and coordinates fully resolved.

---

## Primary Goals

1. **Hierarchical Visual Clarity**  
   - Represent up to five levels of logical application hierarchy.  
   - Preserve parent–child containment visually using nested bounding boxes.  
   - Ensure logical grouping is readable, aligned, and stable under small data changes.  

2. **Whitespace Minimisation**  
   - Dynamically optimise layout to reduce empty space while preserving readability.  
   - Use local search to determine optimal grid or column arrangements per node.  
   - Keep top-level containers aligned in width to maintain visual harmony.

3. **Aspect Ratio Harmony**  
   - Nudge each logical container toward the ISO paper ratio (1:√2 ≈ 1.414).  
   - Maintain proportional balance between width and height without distorting content.

4. **Fixed Pill Dimensions**  
   - Maintain consistent pill width and style for physical applications (`PILL_WIDTH = 300`).  
   - Preserve alignment and proportional spacing within each logical container.

5. **Extents and Background Framing**  
   - Generate a **bounding box** that covers all logical applications, padded by 20 px.  
   - Adjust the bounding box to exact **1:√2** ratio by expanding minimally.  
   - Add a **background** 20 px larger on every edge beneath the bounding box.

---

## Key Features

| Feature | Description |
|----------|--------------|
| **Dynamic Hierarchy Handling** | Supports up to five logical levels (`LogicalLevel1` → `LogicalLevel5`), each with an optional set of physical applications. |
| **Top-Level Ordering** | Forces a domain-specific vertical order: `Core Business Systems` → `Corporate Systems` → `Enabling Systems` → other roots. |
| **Compact Local Search** | Each node independently tests multiple layout configurations (1–3 columns) to minimise area and aspect distortion. |
| **Tallest-First (LPT) Balancing** | Distributes child boxes into columns by height to balance vertical space, reducing unused whitespace. |
| **Aspect-Aware Sizing** | Logical containers expand slightly to approach a 1:√2 ratio, never shrinking below content bounds. |
| **Fixed-Width Pills** | Physical applications are drawn as 300 px-wide pill shapes, maintaining consistent horizontal rhythm. |
| **Unified Root Widths** | All top-level logical applications are widened to the same maximum width for visual alignment. |
| **Layered Backgrounds** | Background and bounding boxes are automatically inserted beneath logical and physical elements. |

---

## Algorithmic Methods

### 1. Hierarchy Construction

- Input rows are read from Neo4j or tabular output containing:
  ```
  LogicalLevel1–5, LogicalID1–5, PhysicalApplication, PhysicalAppID
  ```
- Nodes are created and linked into a tree structure using IDs.
- Applications are attached to their most specific logical node (deepest level available).
- Nodes without parents are identified as **root logical applications**.

---

### 2. Node Sizing (Two-Pass with Adaptive Strategies)

Node sizing uses a **two-pass approach** with **adaptive algorithmic dispatch** based on node complexity.

#### Pass 1: Natural Sizing
- All root nodes are sized bottom-up using their natural dimensions
- Determines the maximum root width that will be used for normalization

#### Pass 2: Predictive Sizing
- Root nodes are re-sized with knowledge of the final normalized width
- Cost function accounts for whitespace created by width normalization
- Optimizes for post-normalization layout quality

#### Leaf Nodes (Physical Applications)
- Try column counts `c ∈ [1..3]`
- For each, compute:
  ```
  width  = max(MIN_LOGICAL_WIDTH, LA_PAD_X*2 + (PILL_WIDTH + (c-1)*PILL_COL_STEP))
  height = LA_PAD_TOP + (rowsNeeded * PILL_ROW_STEP) + LA_PAD_BOTTOM
  ```
- Choose configuration with **minimum cost**:
  ```
  cost = area + whitespace_penalty + (ASPECT_W * area * (ratio - √2)²)
  ```

#### Non-Leaf Nodes: Adaptive Algorithm Selection

**Tier 0: 1-2 Children (Exhaustive Enumeration)**
- Test horizontal (side-by-side) layout
- Test vertical (stacked) layout
- Calculate exact dimensions for each
- Choose layout with minimum cost (accounting for predicted root width if applicable)

**Tier 1: 3-8 Children (Multi-Strategy Exhaustive)**
- Uses MaxRects 2D bin packing algorithm
- Tests all combinations of 5 heuristics × 6 sort strategies = 30 attempts:
  - **Heuristics**: BSSF, BLSF, BAF, BL, CP (contact point)
  - **Sort strategies**: area, height, width, perimeter, aspect ratio variants
- Chooses packing with minimum waste
- Very fast for small node counts, excellent results

**Tier 2: 9-15 Children (Beam Search)**
- Beam width K=12
- Explores top heuristic-sort combinations
- Balances computation time vs quality for medium complexity nodes

**Tier 3: 16+ Children (Genetic Algorithm)**
- Population: 25 chromosomes
- Generations: up to 60 (with early stopping)
- Mutation rate: 0.3
- Each chromosome encodes a heuristic+sort combination
- Optimizes for minimal waste through evolutionary search
- Provides best quality for complex nodes

#### Cost Function
For all tiers, the cost function considers:
```
cost = finalArea + whitespace_penalty + aspect_penalty

where:
  finalArea = predicted_width × height (if root node being normalized)
            = width × height (otherwise)

  whitespace_penalty = WHITESPACE_PENALTY × (finalArea - contentArea)

  aspect_penalty = ASPECT_W × finalArea × (ratio - √2)²
```

The predicted width awareness ensures nodes optimize for their final expanded dimensions, not just their natural size.

---

### 3. Placement

Placement respects the chosen layout strategy for each node:

#### For Nodes Using 2D Packing (1-2 children or 3+ children)
- Children are placed at positions determined by the MaxRects algorithm or exhaustive enumeration
- Positions are relative to the inner area (after padding)
- Maintains optimal 2D spatial arrangement with minimal waste

#### For Leaf Nodes
- Physical applications are placed in pill grids using the chosen column count
- Consistent spacing via `PILL_COL_STEP` and `PILL_ROW_STEP`

#### Root Placement
- Roots are positioned in a **single vertical column** according to business-defined order
- All roots are normalized to the same width for visual alignment

---

### 4. Global Bounding and Background

1. Calculate the combined extents of all logical boxes
2. Expand extents by `BBOX_MARGIN` (20px) to form the **bounding box**
3. Create a **background box** `BG_EXTRA` (20px) larger on all sides than the bounding box
4. Apply a **page margin** of 60px: shift all elements so the background starts at (60, 60)
5. Insert background and bounding box at the base of the layer stack

Layer order (bottom → top):

1. `templateBackground` (at x=60, y=60)
2. `boundingBox` (at x=80, y=80)
3. All `logicalApplication` boxes
4. All `physicalApplication` pills  

---

## Mathematical and Computational Elements

| Technique | Purpose | Complexity |
|------------|----------|-------------|
| **Two-Pass Sizing** | First pass determines natural sizes, second pass optimizes for normalized widths. | 2 × O(n) |
| **MaxRects 2D Bin Packing** | Guillotine-free rectangle packing with multiple heuristics (BSSF, BLSF, BAF, BL, CP). | O(n² × h × s) where h=heuristics, s=sorts |
| **Multi-Strategy Exhaustive (≤8 children)** | Tests 30 combinations (5 heuristics × 6 sorts) for small nodes. | O(30n²) = O(n²) |
| **Beam Search (9-15 children)** | Explores K=12 best candidates per level, pruning search space. | O(K × n² × s) |
| **Genetic Algorithm (16+ children)** | Population-based search with crossover and mutation over 60 generations. | O(pop × gen × n²) = O(1500n²) |
| **Aspect Ratio Cost Function** | Keeps boxes visually consistent (approaches ISO paper ratio √2). | O(1) per evaluation |
| **Whitespace Penalty** | Penalizes unused space, favoring tighter packing. | O(1) per evaluation |
| **Predictive Width Optimization** | Cost function accounts for post-normalization dimensions for root nodes. | O(1) per evaluation |
| **Deterministic Placement** | Coordinates calculated recursively, ensuring reproducible diagrams. | O(n) |

---

## Output Schema

```json
{
  "id": "auto-layout",
  "title": "System Architecture",
  "boxes": [
    {
      "id": "bg1",
      "stencil": "templateBackground",
      "x": 60, "y": 60, "width": 2000, "height": 1400
    },
    {
      "id": "bbox1",
      "stencil": "boundingBox",
      "x": 80, "y": 80, "width": 1960, "height": 1360
    },
    {
      "id": "grp-core-business-systems",
      "stencil": "logicalApplication",
      "x": 100, "y": 100, "width": 1780, "height": 700,
      "headerText": "Core Business Systems"
    },
    {
      "id": "app-core-business-systems-customer-portal",
      "stencil": "physicalApplication",
      "x": 180, "y": 220,
      "bodyText": "Customer Portal"
    }
  ]
}
```

---

## Implemented Optimizations

The algorithm already incorporates several advanced optimization techniques:

1. **Genetic Algorithm (Implemented)** ✓
   - Used for nodes with 16+ children
   - Population-based search with crossover and mutation
   - Adapts to complex layouts automatically

2. **Multi-Strategy Search (Implemented)** ✓
   - Exhaustive evaluation of multiple packing heuristics and sort strategies
   - MaxRects 2D bin packing with 5 heuristics × 6 sort orders
   - Optimal for small to medium node counts

3. **Beam Search (Implemented)** ✓
   - Pruned search space for medium complexity nodes
   - Balances quality vs computation time

4. **Predictive Cost Optimization (Implemented)** ✓
   - Two-pass sizing accounts for post-normalization layout
   - Cost function considers final expanded dimensions
   - Prevents suboptimal choices due to deferred width normalization

## Future Optimisation Possibilities

1. **Force-Directed Refinement**
   - Apply continuous relaxation forces post-layout to equalize spacing and reduce overlap
   - Could improve visual balance without changing topology

2. **Constraint-Based Solver Integration**
   - Model layout as a constraint satisfaction problem (CSP) optimized via linear or integer programming
   - Could handle complex multi-objective constraints

3. **Hierarchical Energy Minimization**
   - Evaluate area, overlap, and edge crossing penalties simultaneously across the tree
   - Global optimization across multiple hierarchy levels

4. **GPU-based Parallel Search**
   - Evaluate multiple configurations concurrently for faster near-optimal convergence
   - Particularly beneficial for genetic algorithm population evaluation

5. **Machine Learning-Based Heuristic Selection**
   - Train a model to predict optimal heuristic/sort combinations based on node characteristics
   - Could reduce search space while maintaining quality

---

## Summary

This algorithm produces a **clean, hierarchical, and ratio-balanced** system architecture diagram with minimal whitespace and predictable output.

### Key Characteristics

**Adaptive Intelligence**
- Automatically selects optimal algorithm based on node complexity (1-2, 3-8, 9-15, or 16+ children)
- Escalates from simple enumeration to sophisticated genetic algorithms as needed
- Balances computation time with layout quality

**Engineering Precision**
- Deterministic output: same input always produces identical diagrams
- Fixed stencil conventions for renderer compatibility
- Two-pass sizing eliminates optimization blind spots

**Aesthetic Optimization**
- MaxRects 2D bin packing minimizes whitespace
- Aspect ratio harmony (targets ISO √2 ratio)
- Predictive cost function accounts for post-normalization layout
- 60px page margin provides visual breathing room

**Performance**
- Efficient for typical hierarchies (completes in <2 seconds)
- Scales gracefully to complex nodes through tiered algorithm selection
- Genetic algorithm provides high-quality results for complex layouts

The architecture supports further evolution toward global optimization strategies (force-directed layout, constraint solvers, or machine learning) without breaking schema compatibility.
