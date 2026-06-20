export type TutorialStep = {
  id: string;
  title: string;
  description: string;
  initialCode: string;
  goal: string;
  check: (output: any, code: string) => boolean;
  fileExtension?: 'ts' | 'tsx';
};

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'intro',
    title: 'What is conf-ts?',
    description:
      'conf-ts is a configuration language built on TypeScript. It allows you to write type-safe, dynamic configurations and expression strings using the full power of TypeScript and compile them to static JSON or YAML.',
    goal: 'Explore the example code to see how types, macros, and logic come together.',
    initialCode: `import { env, arrayMap, expr, type Expr } from '@conf-ts/macro';

// 1. Define strict types for your configuration
interface ServerConfig {
  host: string;
  port: number;
  debug: boolean;
  services: string[];
  quotaRule: Expr<{ requestCount: number; quota: number }, boolean>;
}

// 2. Use logic and macros to generate values
// The playground simulates NODE_ENV as 'production'
const isDev = env('NODE_ENV') === 'development';
const basePort = 3000;

const services = ['api', 'auth', 'payment'];
const quotaRule = expr<{ requestCount: number; quota: number }, boolean>(
  ctx => ctx.requestCount < ctx.quota,
);

// 3. Export the final configuration object
export default {
  host: isDev ? 'localhost' : 'api.example.com',
  port: basePort + 80, // Dynamic calculation
  debug: isDev,
  // Use macros to transform data at compile time
  services: arrayMap(services, (s) => \`svc-\${s}\`),
  // Build a type-safe expression string
  quotaRule,
} satisfies ServerConfig;
`,
    check: () => true,
  },
  {
    id: 'basics',
    title: 'The Basics',
    description: "Let's start by exporting a simple configuration object.",
    goal: 'Export a simple object with a "message" property set to "Hello World".',
    initialCode: `// Let's start by exporting a simple configuration object.

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
    description:
      'One of the biggest benefits of conf-ts is type safety. You can use the `satisfies` operator to ensure your configuration matches a specific schema.',
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
      return (
        output &&
        (output.theme === 'light' || output.theme === 'dark') &&
        typeof output.version === 'number'
      );
    },
  },
  {
    id: 'macros',
    title: 'Macros: Environment Variables',
    description:
      'conf-ts supports macros that run at compile time. The `env` macro allows you to inject environment variables into your configuration.',
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
    description:
      'You can also use macros to transform data. `arrayMap` lets you transform arrays at compile time.',
    goal: 'Use `arrayMap` to double the numbers in the list.',
    initialCode: `import { arrayMap } from '@conf-ts/macro';

const numbers = [1, 2, 3, 4, 5];

export default {
  doubled: numbers, // Use arrayMap here
};
`,
    check: (output: any) => {
      return (
        output &&
        Array.isArray(output.doubled) &&
        output.doubled.join(',') === '2,4,6,8,10'
      );
    },
  },
  {
    id: 'expr',
    title: 'Macros: Expressions',
    description:
      '`expr` preserves a typed callback at runtime and compiles it to an expression string, so `ctx => ctx.requestCount < ctx.quota` becomes `"requestCount < quota"` in generated output.',
    goal: 'Use `expr` to create an `allowRequest` rule for `requestCount < quota`.',
    initialCode: `import { expr, type Expr } from '@conf-ts/macro';

type RequestContext = {
  requestCount: number;
  quota: number;
};

type LimitsConfig = {
  allowRequest: Expr<RequestContext, boolean>;
};

export default {
  allowRequest: 'TODO',
} satisfies LimitsConfig;
`,
    check: (output: any) => {
      return output && output.allowRequest === 'requestCount < quota';
    },
  },
  {
    id: 'jsx',
    title: 'JSX: Declarative Config',
    description:
      'conf-ts supports JSX as a declarative syntax for nested structured data. By default, each element compiles to a plain `{ type, props }` object — no DOM or React involved.',
    goal: 'Add a <button type="submit" label="Send" /> inside the <form>.',
    fileExtension: 'tsx',
    initialCode: `/** @jsxImportSource @conf-ts/macro */

// JSX elements compile to { type, props } objects by default — no DOM needed.
// Use it to declare UI schemas, API configs, or any nested structure.

export default (
  <form action="/submit" method="POST">
    <input name="email" type="email" required />
    {/* TODO: Add a <button type="submit" label="Send" /> here */}
  </form>
);
`,
    check: (output: any) => {
      const children = output?.props?.children;
      if (!Array.isArray(children)) return false;
      return children.some(
        (c: any) => c?.type === 'button' && c?.props?.label === 'Send',
      );
    },
  },
  {
    id: 'complex-enums',
    title: 'Complex Types: Enums & Interfaces',
    description:
      'conf-ts handles complex TypeScript features like enums and interfaces seamlessly. You can use them to structure your configuration.',
    goal: 'Define an enum `Role` and an interface `User`, then export a list of users containing at least one Admin.',
    initialCode: `// Define an enum for User Roles
enum Role {
  Admin = 'admin',
  User = 'user',
  Guest = 'guest',
}

// Define an interface for User
interface User {
  id: number;
  username: string;
  role: Role;
  isActive: boolean;
}

const user = {
  id: 1,
  username: 'admin',
  role: Role.User,
  isActive: true,
};

export default [
  // TODO: Add at least one user with Role.Admin
];
`,
    check: (output: any) => {
      return (
        Array.isArray(output) && output.some((u: any) => u.role === 'admin')
      );
    },
  },
];
