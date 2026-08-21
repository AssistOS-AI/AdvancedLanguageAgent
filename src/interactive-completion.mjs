import { registeredRepositoryName } from './repository-sources.mjs';

const removePrefix = '/repo remove ';

export function repositoryCompletionNames(repositoryPaths) {
  return [...new Set(repositoryPaths.map(registeredRepositoryName).filter(Boolean))].sort();
}

export function createInteractiveCompleter(getRepositoryPaths) {
  return (line) => {
    const input = String(line);
    if (!removePrefix.startsWith(input) && !input.startsWith(removePrefix)) return [[], input];
    const candidates = repositoryCompletionNames(getRepositoryPaths())
      .map((name) => `${removePrefix}${name}`);
    return [candidates.filter((candidate) => candidate.startsWith(input)), input];
  };
}
