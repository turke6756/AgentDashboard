export enum IconPack {
  Angular = 'angular',
  Nest = 'nest',
  Ngrx = 'angular_ngrx',
  React = 'react',
  Redux = 'react_redux',
  Roblox = 'roblox',
  Qwik = 'qwik',
  Vue = 'vue',
  Vuex = 'vue_vuex',
  Bashly = 'bashly',
}

export enum FileNamePattern {
  Ecmascript = 'ecmascript',
  Configuration = 'configuration',
  NodeEcosystem = 'nodeEcosystem',
  Cosmiconfig = 'cosmiconfig',
  Yaml = 'yaml',
  Dotfile = 'dotfile',
}

export type Patterns = Record<string, FileNamePattern>;

export interface CloneOptions {
  base: string;
  color?: string;
  lightColor?: string;
}

export interface FileIcon {
  name: string;
  fileExtensions?: string[];
  fileNames?: string[];
  patterns?: Patterns;
  light?: boolean;
  disabled?: boolean;
  enabledFor?: IconPack[];
  clone?: CloneOptions;
}

export interface FileIcons {
  defaultIcon: { name: string };
  icons: FileIcon[];
}

export interface FolderIcon {
  name: string;
  folderNames: string[];
  light?: boolean;
  enabledFor?: IconPack[];
  clone?: CloneOptions;
}

export interface FolderTheme {
  name: string;
  defaultIcon: { name: string };
  rootFolder?: { name: string };
  icons?: FolderIcon[];
}

export type FileIconWithPatterns = (FileIcon & { patterns?: Patterns })[];
