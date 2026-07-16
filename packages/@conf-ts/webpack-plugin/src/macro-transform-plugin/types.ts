import type { SourceProject } from '@conf-ts/compiler';

export const CONF_TS_MACRO_TRANSFORM_META = 'confTsMacroTransform' as const;

export interface MacroTransformLoaderMeta {
  [CONF_TS_MACRO_TRANSFORM_META]?: {
    project: SourceProject;
    transformDependencies: string[];
  };
  [key: string]: unknown;
}

export type MacroTransformImplementation = 'typescript' | 'native';
