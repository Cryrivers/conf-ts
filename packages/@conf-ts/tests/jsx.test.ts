import { describe, it } from 'vitest';

import { assertJsxOutput } from './test-utils';

describe('JSX Test', () => {
  it('should handle intrinsic tags, attributes, children, fragments, and custom tags', () => {
    assertJsxOutput('basic');
  });

  it('should handle spread attributes and key handling', () => {
    assertJsxOutput('spread');
  });

  it('should handle imports from other files', () => {
    assertJsxOutput('imports');
  });

  it('should handle macro calls inside JSX attributes', () => {
    assertJsxOutput('with-macros', { macroMode: true });
  });
});
