import defaultConfig, * as namespaceConfig from './reexport-source';
import { ALPHA, BETA, GAMMA } from './reexport-mid';

export default {
  defaultName: defaultConfig.name,
  namespaceAlpha: namespaceConfig.ALPHA,
  namespaceBeta: namespaceConfig.BETA,
  alpha: ALPHA,
  beta: BETA,
  gamma: GAMMA,
};
