import { describe, expect, it } from 'vitest';

import { assertSpecError, assertSpecOutput } from './test-utils';

describe('Logical Operators Test', () => {
  it('should handle && operator correctly', () => {
    assertSpecOutput('logical-and');
  });

  it('should handle || operator correctly', () => {
    assertSpecOutput('logical-or');
  });

  it('should handle ?? operator correctly', () => {
    assertSpecOutput('null-coalescing');
  });

  it('should handle mixed logical operators', () => {
    assertSpecOutput('mixed-logical');
  });

  it('should handle unary operators', () => {
    assertSpecOutput('unary-ops');
  });
});
