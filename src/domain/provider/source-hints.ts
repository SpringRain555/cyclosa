export const MAX_SOURCE_HINTS_PER_GROUP = 12;

export interface SourceHints {
  readonly readable: readonly string[];
  readonly untried: readonly string[];
  readonly loginWalled: readonly string[];
  readonly unfetchable: readonly string[];
}

export const EMPTY_SOURCE_HINTS: SourceHints = {
  readable: [],
  untried: [],
  loginWalled: [],
  unfetchable: [],
};
