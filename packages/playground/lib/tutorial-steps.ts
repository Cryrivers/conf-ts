
export type TutorialStep = {
  id: string;
  title: string;
  description: string;
  initialCode: string;
  goal: string;
  check: (output: any, code: string) => boolean;
};

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'intro',
    title: 'Welcome to conf-ts',
    description: 'conf-ts allows you to write configuration in TypeScript and compile it to JSON or YAML. It gives you type safety, macros, and a great developer experience.',
    goal: 'Export a simple object with a "message" property set to "Hello World".',
    initialCode: `// Welcome to the conf-ts playground!
// Let's start by exporting a simple configuration object.

export default {
  // TODO: Add a message property here
};
`,
    check: (output: any) => {
      return output && output.message === 'Hello World';
    },
  },
  {
    id: 'types',
    title: 'Type Safety',
    description: 'One of the biggest benefits of conf-ts is type safety. You can use the `satisfies` operator to ensure your configuration matches a specific schema.',
    goal: 'Define a Config type and ensure the export satisfies it.',
    initialCode: `// Define a type for our configuration
type Config = {
  theme: 'light' | 'dark';
  version: number;
};

export default {
  theme: 'blue', // This should be an error!
  version: 1,
} satisfies Config;
`,
    check: (output: any, code: string) => {
      // We can't easily check type errors in runtime without the compiler diagnostics,
      // but for this simple check we'll verify the output is correct.
      return output && (output.theme === 'light' || output.theme === 'dark') && typeof output.version === 'number';
    },
  },
  {
    id: 'macros',
    title: 'Macros: Environment Variables',
    description: 'conf-ts supports macros that run at compile time. The `env` macro allows you to inject environment variables into your configuration.',
    goal: 'Use the `env` macro to read the "NODE_ENV" variable.',
    initialCode: `import { env } from '@conf-ts/macro';

export default {
  // The playground simulates NODE_ENV as 'production'
  environment: 'development', 
};
`,
    check: (output: any) => {
      return output && output.environment === 'production';
    },
  },
  {
    id: 'array-map',
    title: 'Macros: Array Map',
    description: 'You can also use macros to transform data. `arrayMap` lets you transform arrays at compile time.',
    goal: 'Use `arrayMap` to double the numbers in the list.',
    initialCode: `import { arrayMap } from '@conf-ts/macro';

const numbers = [1, 2, 3, 4, 5];

export default {
  doubled: numbers, // Use arrayMap here
};
`,
    check: (output: any) => {
      return output && Array.isArray(output.doubled) && output.doubled.join(',') === '2,4,6,8,10';
    },
  },
];
