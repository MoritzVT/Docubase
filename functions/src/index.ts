// Firebase discovers deployed callable functions through this small entry point.
// Each endpoint's implementation lives with its feature.
export { health } from "./health.js";
export { deleteProject, uploadVisualFrame } from "./projects.js";
export {
  refreshVisualAnalysis,
  submitVisualAnalysis,
} from "./visual-analysis.js";
export {
  cancelSearchIndex,
  estimateSearchIndex,
  getSearchIndexStatus,
  refreshSearchIndex,
  searchProject,
  startSearchIndex,
} from "./semantic-search.js";
