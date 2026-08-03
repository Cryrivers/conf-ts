import defaultModifier, * as modifiers from './modifier-reexport';
import {
  add,
  groupedModifiers,
  stringify,
} from './modifier-reexport';

export default {
  defaultImport: defaultModifier({ value: 1 }),
  namespaceReexport: modifiers.renamedModifier({ value: 2 }, 3),
  exportedNamespace: groupedModifiers.add({ value: 3 }, 4),
  starReexport: add({ value: 4 }, 5),
  stringified: stringify(6),
};
