const name = 'John Doe';

enum Greeting {
  Hello = 'Hello',
  Hi = 'Hi',
  Welcome = 'Welcome',
}
export default {
  name,
  greeting: `Hello, ${name}!`,
  greetingAlt: `${Greeting.Welcome}, ${name}!`,
};
