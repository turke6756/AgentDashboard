import { FileNamePattern, type FileIcon, type FileIconWithPatterns, type Patterns } from './types';

const mapPatterns = (patterns: Patterns): string[] => {
  return Object.entries(patterns).flatMap(([fileName, pattern]) => {
    switch (pattern) {
      case FileNamePattern.Ecmascript:
        return [
          `${fileName}.js`, `${fileName}.mjs`, `${fileName}.cjs`,
          `${fileName}.ts`, `${fileName}.mts`, `${fileName}.cts`,
        ];
      case FileNamePattern.Configuration:
        return [
          `${fileName}.json`, `${fileName}.jsonc`, `${fileName}.json5`,
          `${fileName}.yaml`, `${fileName}.yml`, `${fileName}.toml`,
        ];
      case FileNamePattern.NodeEcosystem:
        return [
          `${fileName}.js`, `${fileName}.mjs`, `${fileName}.cjs`,
          `${fileName}.ts`, `${fileName}.mts`, `${fileName}.cts`,
          `${fileName}.json`, `${fileName}.jsonc`, `${fileName}.json5`,
          `${fileName}.yaml`, `${fileName}.yml`, `${fileName}.toml`,
        ];
      case FileNamePattern.Cosmiconfig:
        return [
          `.${fileName}rc`, `.${fileName}rc.json`, `.${fileName}rc.jsonc`,
          `.${fileName}rc.json5`, `.${fileName}rc.yaml`, `.${fileName}rc.yml`,
          `.${fileName}rc.toml`, `.${fileName}rc.js`, `.${fileName}rc.mjs`,
          `.${fileName}rc.cjs`, `.${fileName}rc.ts`, `.${fileName}rc.mts`,
          `.${fileName}rc.cts`,
          `.config/${fileName}rc`, `.config/${fileName}rc.json`,
          `.config/${fileName}rc.jsonc`, `.config/${fileName}rc.json5`,
          `.config/${fileName}rc.yaml`, `.config/${fileName}rc.yml`,
          `.config/${fileName}rc.toml`, `.config/${fileName}rc.js`,
          `.config/${fileName}rc.mjs`, `.config/${fileName}rc.cjs`,
          `.config/${fileName}rc.ts`, `.config/${fileName}rc.mts`,
          `.config/${fileName}rc.cts`,
          `${fileName}.config.json`, `${fileName}.config.jsonc`,
          `${fileName}.config.json5`, `${fileName}.config.yaml`,
          `${fileName}.config.yml`, `${fileName}.config.toml`,
          `${fileName}.config.js`, `${fileName}.config.mjs`,
          `${fileName}.config.cjs`, `${fileName}.config.ts`,
          `${fileName}.config.mts`, `${fileName}.config.cts`,
        ];
      case FileNamePattern.Yaml:
        return [`${fileName}.yaml`, `${fileName}.yml`];
      case FileNamePattern.Dotfile:
        return [`.${fileName}`, fileName];
      default:
        return [];
    }
  });
};

export const parseByPattern = (rawFileIcons: FileIconWithPatterns): FileIcon[] => {
  return rawFileIcons.map(({ patterns, fileNames = [], ...rest }) => ({
    ...rest,
    fileNames: patterns ? [...mapPatterns(patterns), ...fileNames] : fileNames,
  }));
};
