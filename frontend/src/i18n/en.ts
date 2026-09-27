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

  "documents.title": "Documents",
  "documents.note":
    "Your uploads are private to your account and can be used in Telegram when RAG mode is active. Web chat is text-only and does not use these documents.",
  "documents.linkWarning":
    "Link Telegram before uploading if you plan to use RAG there. Documents are not moved when separate accounts are merged and can prevent linking.",
  "documents.chooseFile": "Choose a document file",
  "documents.hint": "PDF, TXT, MD or DOCX, up to {max} MiB.",
  "documents.problemExtension": "Only PDF, TXT, MD and DOCX files can be uploaded.",
  "documents.problemEmpty": "This file is empty.",
  "documents.problemTooLarge": "This file is larger than the {max} MiB limit.",
  "documents.problemNameTooLong": "This file’s name is longer than {max} characters.",
  "documents.unavailable": "Document storage is unavailable right now. Please try again later.",
  "documents.uploadTimedOut":
    "The upload took too long, so we can’t tell whether it finished. Use Refresh to check your documents before uploading again.",
  "documents.uploadUnconfirmed":
    "We couldn’t confirm whether the upload finished. Use Refresh to check your documents before uploading again.",
  "documents.deleteUnconfirmed": "We couldn’t confirm whether the document was deleted. Use Refresh to check the list.",
  "documents.tooLargeForServer": "This file is too large for the server. The limit is {max} MiB.",
  "documents.notAccepted":
    "The server didn’t accept this file. Check that it is a PDF, TXT, MD or DOCX file with an ordinary name.",
  "documents.uploadServerFailure": "The server couldn’t process this file. Try again, or try a different file.",
  "documents.uploadGeneric": "Couldn’t upload this file. {detail}",
  "documents.deleteNotFound": "This document was not found. It may already be deleted; use Refresh to update the list.",
  "documents.deleteServerFailure":
    "The document couldn’t be fully deleted. It may no longer appear in the list; use Refresh to check before trying again.",
  "documents.deleteGeneric": "Couldn’t delete this document. {detail}",
  "documents.upload": "Upload",
  "documents.uploading": "Uploading…",
  "documents.uploadingStatus": "Uploading… the server processes and indexes the file, so this can take a while.",
  "documents.uploaded": "Uploaded “{name}”.",
  "documents.deleted": "Deleted “{name}”.",
  "documents.yourDocuments": "Your documents",
  "documents.refresh": "Refresh",
  "documents.loading": "Loading documents…",
  "documents.loadFailed": "Couldn’t load your documents. {detail}",
  "documents.retry": "Retry",
  "documents.empty": "No documents yet.",
  "documents.uploadedPrefix": "Uploaded",
  "documents.delete": "Delete",
  "documents.confirmDeletionLabel": "Confirm deletion",
  "documents.confirmDeleteQuestion": "Delete this document? This can’t be undone.",
  "documents.cancel": "Cancel",
  "documents.confirmDelete": "Confirm Delete",
  "documents.deleting": "Deleting…",
  "documents.deletingStatus": "Deleting this document…",
  "documents.previous": "Previous",
  "documents.next": "Next",
  "documents.page": "Page {n}",
  "documents.pagerLabel": "Documents pages",

  "account.title": "Account connections",
  "account.telegram": "Telegram",
  "account.linked": "Linked",
  "account.notLinked": "Not linked",
  "account.linkTelegram": "Link Telegram",
  "account.creatingLink": "Creating link…",
  "account.openInTelegram": "Open this short-lived link in Telegram. Return here afterward and check the status.",
  "account.expiresPrefix": "Expires",
  "account.openTelegram": "Open Telegram",
  "account.checkLinkStatus": "Check link status",
  "account.checking": "Checking…",
  "account.issueNewLink": "Issue a new link",
  "account.linkReady": "Telegram link ready. Open it, then check the link status here.",
  "account.isLinked": "Telegram is linked.",
  "account.notLinkedYet": "Telegram is not linked yet. Complete the step in Telegram and try again.",
  "account.githubTitle": "GitHub web access",
  "account.connected": "Connected",
  "account.disconnectGithub": "Disconnect GitHub web access",
  "account.confirmDisconnectionLabel": "Confirm GitHub disconnection",
  "account.disconnectEndsAccess": "This ends web access and signs this browser out.",
  "account.telegramDataRemains": "Your Telegram account and retained data will remain.",
  "account.emptyAccountMayBeRemoved":
    "An empty web-only account may be removed; the server will refuse if retained data would be stranded.",
  "account.cancel": "Cancel",
  "account.confirmDisconnect": "Confirm disconnect",
  "account.disconnecting": "Disconnecting…",
  "account.creatingLinkStatus": "Creating a Telegram link…",
  "account.checkingLinkStatus": "Checking Telegram link status…",
  "account.disconnectingStatus": "Disconnecting GitHub web access…",
  "account.linkUnavailable": "Telegram linking is unavailable right now. Please try again later.",
  "account.linkConflict": "A current GitHub connection is required to start Telegram linking.",
  "account.unlinkConflict": "GitHub access can’t be disconnected right now. Your account and session are unchanged.",

  "settings.title": "Settings",
  "settings.note":
    "Your saved mode is shared with Telegram. Web chat is text-only, so this setting doesn’t change how chat works here.",
  "settings.preferredMode": "Preferred mode",
  "settings.modeText": "Text",
  "settings.modeVoice": "Voice",
  "settings.modeVision": "Vision",
  "settings.modeRag": "RAG",
  "settings.loadingOption": "Loading…",
  "settings.unavailable": "Unavailable",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.retry": "Retry",
  "settings.loadingStatus": "Loading settings…",
  "settings.savingStatus": "Saving your preference…",
  "settings.loadFailed": "Couldn’t load your settings. {detail}",
  "settings.saved": "Preference saved.",
  "settings.saveFailed": "Couldn’t save your preference. {detail}",
} as const;

/** Every locale supplies exactly these keys: a missing or extra key is a type error. */
export type Messages = { readonly [K in keyof typeof en]: string };
