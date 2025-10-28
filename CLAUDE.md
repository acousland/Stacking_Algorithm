# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Hierarchical Layout Optimisation Algorithm** for automatic diagram generation. It takes hierarchical data (e.g., from Neo4j) describing multi-level application architectures and produces compact, aesthetically balanced visual layouts.

**Key characteristics:**
- Standalone JavaScript implementation (no dependencies)
- Deterministic layout engine suitable for diagram renderers (e.g., Renoir)
- Handles up to 5-level hierarchies with physical and logical applications
- Optimizes for whitespace, aspect ratio (ISO 1:√2), and visual clarity

## Project Structure

```
Stacking_Algorithm/
├── packing_algo.js              # Core algorithm implementation (~13 KB)
├── spec.md                      # Technical specification and design documentation
├── APM rendering agent.json     # n8n workflow integrating algorithm with Neo4j & Renoir
└── CLAUDE.md                    # This file
```

**No external dependencies** - pure JavaScript suitable for integration into n8n nodes or other environments.

## How It Works: Architecture

The algorithm processes hierarchical data through a four-stage pipeline:

### 1. Hierarchy Construction
- Ingests tabular data with columns: `LogicalLevel1-5`, `LogicalID1-5`, `PhysicalApplication`, `PhysicalAppID`
- Builds a tree structure representing parent-child relationships
- Logical levels 5→1 (most general to most specific)
- Physical applications are leaf nodes ("pills" at 300×60 pixels)

### 2. Node Sizing & Optimization
- Each node tests 1-3 column configurations (via local search)
- Selects layout with minimum cost function:
  ```
  cost = area + ASPECT_W × area × (ratio - √2)²
  ```
- Uses Tallest-First (LPT) algorithm to balance child distribution across columns
- Applies minimal padding post-sizing to achieve target 1:√2 ratio

### 3. Recursive Placement
- Positions nodes respecting containment hierarchy
- Applies padding constraints (LA_PAD_X, LA_PAD_TOP, LA_PAD_BOTTOM)
- Maintains fixed pill dimensions (300×60)

### 4. Global Framing
- Generates bounding box at exact aspect ratio
- Creates background frame (20px larger on all edges)
- Outputs Renoir-compatible JSON

## Key Configuration Constants

Located at the top of `packing_algo.js`, these define visual and algorithmic behavior:

```javascript
// Physical dimensions
PILL_WIDTH = 300          // Physical app width (px)
PILL_HEIGHT = 60          // Physical app height (px)
PILL_MAX_COLS = 3         // Max columns to test (search space: 1-3)

// Container sizing
MIN_LOGICAL_WIDTH = 1180  // Minimum container width
LA_PAD_X = 80             // Horizontal padding inside containers
LA_PAD_TOP = 120          // Top padding
LA_PAD_BOTTOM = 80        // Bottom padding

// Aspect ratio tuning
TARGET_RATIO = 1.414...   // ISO paper ratio (√2)
ASPECT_W = 0.0002         // Weight for aspect ratio penalty in cost function
```

Adjusting these values affects:
- **PILL_MAX_COLS**: Search time (O(n×k²)) vs. layout quality
- **Padding values**: Whitespace and visual breathing room
- **ASPECT_W**: How strongly the algorithm prioritizes 1:√2 ratio
- **MIN_LOGICAL_WIDTH**: Minimum container size constraints

## n8n Integration

The project includes a **production-ready n8n workflow** (`APM rendering agent.json`) that orchestrates the complete pipeline from data retrieval to diagram rendering.

### Workflow Pipeline

```
Manual Trigger
      ↓
Neo4j Query (ExecuteQuery graphDb)
      ↓
JavaScript Code Node (packing_algo embedded)
      ↓
HTTP Request (send to Renoir API)
```

### Node Breakdown

**1. Manual Trigger** - Starts the workflow execution

**2. Neo4j Query Node** - `ExecuteQuery graphDb`
- Executes Cypher query to fetch hierarchical application data
- Returns tabular result set with columns:
  - `PhysicalApplication`, `PhysicalAppID`
  - `LogicalLevel1-5`, `LogicalID1-5`
- Query structure:
  - Matches all physical apps
  - Optionally traces up through 5 levels of logical parents via `IMPLEMENTS` and `CHILD_OF` relationships
  - Orders results by logical hierarchy then physical app name
- Uses credential: `Neo4j account` (stored in n8n)

**3. JavaScript Code Node** - `Code in JavaScript`
- Embeds the complete layout algorithm as inline n8n code
- Accepts Neo4j query results as input
- Returns JSON diagram at `json.diagram` (stringified JSON)
- Configuration constants can be tuned directly in this node

**4. HTTP Request Node** - Send to Renoir
- POSTs diagram JSON to Renoir API endpoint: `https://fromhereon-renoir.replit.app/api/diagrams`
- Body parameters:
  - `diagramData`: stringified JSON from code node
  - `name`: "Application Portfolio Model"
- Uses credential: `Renoir API` (HTTP Bearer token)

### Workflow Credentials Required

To run this workflow, configure in n8n:
1. **Neo4j account** - Connection to Neo4j database with hierarchical application data
2. **Renoir API** - Bearer token for Renoir visualization API

### Modifying the Workflow

- **To change Neo4j query:** Edit the `cypherQuery` parameter in the `ExecuteQuery graphDb` node
- **To tune algorithm parameters:** Edit constants at the top of the `Code in JavaScript` node (same constants as `packing_algo.js`)
- **To change output destination:** Modify the `url` and body parameters in the `HTTP Request` node

## Running & Testing

**There are currently no automated tests or build scripts.** The algorithm is a pure JavaScript module.

### To use the algorithm:
1. **As n8n workflow:** Import `APM rendering agent.json` into n8n, configure credentials, and execute

2. **As standalone code:** Load `packing_algo.js` in Node.js or browser
   ```javascript
   // Node.js
   const { calculateLayout } = require('./packing_algo.js');
   const result = calculateLayout(inputData);
   ```

3. **Validate output:** The result is JSON conforming to the output schema in `spec.md`

### To modify the algorithm:
- Edit `packing_algo.js` for implementation changes
- Update `spec.md` for specification/design changes
- Update the code node in `APM rendering agent.json` if deploying via n8n
- Key functions/sections in the code:
  - Hierarchy construction from input rows
  - `sizeLeafOptimised()` - Local search for pill layouts (1-3 columns)
  - `sizeNonLeafOptimised()` - Local search for child layouts with LPT balancing
  - `assignChildrenToColumns()` - Tallest-first column balancing algorithm
  - `placeNode()` - Recursive placement with padding
  - Bounding box and background generation with aspect ratio enforcement

## Output Format

The algorithm produces JSON with nested stencil objects:

```json
{
  "id": "auto-layout",
  "title": "System Architecture",
  "boxes": [
    {
      "id": "bg1",
      "stencil": "templateBackground",
      "x": 0, "y": 0, "width": 2000, "height": 1400
    },
    {
      "id": "bbox1",
      "stencil": "boundingBox",
      "x": 20, "y": 20, "width": 1960, "height": 1360
    },
    {
      "id": "grp-[logical-id]",
      "stencil": "logicalApplication",
      "x": 40, "y": 40, "width": 1780, "height": 700,
      "headerText": "Category Name"
    },
    {
      "id": "app-[physical-id]",
      "stencil": "physicalApplication",
      "x": 120, "y": 160,
      "bodyText": "Application Name"
    }
  ]
}
```

**Stencil types:**
- `templateBackground` - Outer frame (20px margin)
- `boundingBox` - Content boundary
- `logicalApplication` - Hierarchical container
- `physicalApplication` - Individual application (leaf node)

## Performance Notes

- **Time complexity:** O(n × k²) where n = nodes, k = max columns (3)
- **Space complexity:** O(n) for tree structure
- **Deterministic:** Same input always produces identical output
- **Scalability:** Designed for hierarchies up to 5 levels

## Future Enhancement Opportunities

The spec documents several optimizations for future work:
1. Simulated annealing or genetic algorithms for global optimization
2. Force-directed post-layout refinement
3. Constraint satisfaction problem (CSP) solvers
4. Hierarchical energy minimization
5. GPU-based parallel column search

Currently the local search with LPT balancing is sufficient for target use cases.

## Key Design Decisions

1. **Fixed pill dimensions (300×60)** - Simplifies layout calculation and ensures consistent UI
2. **Local search instead of global optimization** - Fast deterministic results suitable for real-time rendering
3. **Tallest-First load balancing** - Simple, effective heuristic for column distribution
4. **1:√2 aspect ratio target** - Aesthetic balance based on ISO paper standards
5. **Deterministic output** - Same input always produces identical diagrams for reproducibility

## Git Status

- Initial repository with no commits yet
- Files: `packing_algo.js`, `spec.md`, `CLAUDE.md`, `APM rendering agent.json` untracked
- No CI/CD pipelines or automated tests configured
- Ready for initial commit when project is stable
