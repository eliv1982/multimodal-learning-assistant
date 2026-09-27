/**
 * English: the source of truth for the message keys and for each message's
 * `{placeholder}` names, and the fallback for any message another locale lacks.
 * The product name is not a message: see ../branding.ts.
 */
export const en = {
  "language.label": "Language",

  "title.signIn": "Sign in — {product}",
  "title.verificationError": "Can’t verify your session — {product}",

  "loading.session": "Checking your session…",

  "signIn.prompt": "You need to sign in to continue.",
  "signIn.github": "Sign in with GitHub",

  "verification.title": "We couldn’t verify your session",
  "verification.body":
    "This looks like a connection or server problem. You have not been signed out — try again in a moment.",
  "verification.retry": "Try again",

  "shell.signedIn": "You’re signed in",
  "shell.signOut": "Sign out",
  "shell.signingOut": "Signing out…",
  "shell.signOutFailed":
    "We couldn’t confirm that you were signed out, so you’re still signed in here. Please try again.",
  "shell.settings": "Settings",
  "shell.settingsTitle": "Account and settings",
  "shell.settingsClose": "Close",
  "shell.memberSince": "Member since",

  "chat.title": "Ask the assistant",
  "chat.note":
    "This conversation isn’t saved: refreshing the page, signing out, or an expired session clears it. Only your recent messages are sent along as context.",
  "chat.empty": "Ask a question to get started.",
  "chat.you": "You",
  "chat.assistant": "Assistant",
  "chat.transcriptLabel": "Conversation",
  "chat.messageLabel": "Your message",
  "chat.waiting": "Waiting for a reply…",
  "chat.notAdded": "Your message wasn’t added to the conversation. It’s still in the box below.",
  "chat.hint": "Enter to send, Shift+Enter for a new line. {length} / {max}",
  "chat.tooLong": "Too long: {length} of {max} characters. Shorten it to send.",
  "chat.send": "Send",
  "chat.sending": "Sending…",

  // The fixed, client-owned failure messages of api/client.ts and api/chat.ts.
  "error.network": "Unable to reach the server. Check your connection and try again.",
  "error.timeout": "The server took too long to respond. Please try again.",
  "error.unexpectedResponse": "The server sent an unexpected response.",
  "error.generic": "Something went wrong. Please try again.",
  "error.unauthorized": "Your session is no longer valid. Please sign in again.",
  "error.forbidden": "The server refused this request. Reload the page and try again.",
  "error.rateLimited": "Too many requests. Please wait a moment and try again.",
  "error.server": "The server ran into a problem. Please try again in a moment.",
  "error.chatRequestRefused": "This message can’t be sent. Make sure it isn’t empty or too long, then try again.",
} as const;

/** Every locale supplies exactly these keys: a missing or extra key is a type error. */
export type Messages = { readonly [K in keyof typeof en]: string };
