// The signed-in app is client-rendered: it is filled from live subscriptions and sits behind
// sign-in, and rendering it on the server would only risk the Durable Object dev deadlock.
export const ssr = false;
