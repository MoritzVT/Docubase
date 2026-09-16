// Firebase discovers deployed callable functions through this small entry point.
// Each endpoint's implementation lives with its feature.
export { health } from "./health.js";
export { deleteProject, uploadVisualFrame } from "./projects.js";
export { refreshVisualAnalysis } from "./visual/refresh.js";
export { submitVisualAnalysis } from "./visual/submit.js";
export {
  cancelSearchIndex,
  estimateSearchIndex,
  getSearchIndexStatus,
  refreshSearchIndex,
  searchProject,
  startSearchIndex,
} from "./semantic-search.js";
