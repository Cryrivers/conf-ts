import { describe, it } from 'vitest';



import { assertEdgeCaseOutput } from './test-utils';


describe('Edge Cases Test', () => {
  it('should compile field key mappings correctly', () => {
    assertEdgeCaseOutput('field-key-mapping');
  });

  it('should compile raw json correctly', () => {
    assertEdgeCaseOutput('raw');
  });
});