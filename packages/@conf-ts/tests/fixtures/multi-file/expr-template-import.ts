import defaultTemplate, * as templates from './expr-template-reexport';
import {
  groupedTemplates,
  multiplied,
  runtimeAliasString,
  staticNamespaceString,
} from './expr-template-reexport';

export default {
  defaultImport: defaultTemplate(2),
  namespaceReexport: templates.renamedTemplate(3),
  exportedNamespace: groupedTemplates.multiplied(4),
  starReexport: multiplied(5),
  runtimeAliasString: runtimeAliasString(),
  staticNamespaceString: staticNamespaceString(6),
};
