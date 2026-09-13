/** Shapes the gateway UI renders. Data comes from the backend at runtime. */

export type ChatKind = "dm" | "group";

export type ChatPreview = {
  id: string;
  name: string;
  preview: string;
  time: string;
  /** Sort key: seconds since epoch of the last message. */
  lastAt?: number;
  unread: number;
  kind: ChatKind;
  avatar: "photo" | "initials" | "icon";
  photo?: string;
  initials?: string;
  icon?: "users" | "code" | "chart" | "headset" | "palette" | "support";
  online?: boolean;
  phone?: string;
  lastSeen?: string;
};

export type BubbleMediaType = "image" | "video" | "audio" | "ptt" | "document" | "sticker";

/** An attachment on a message. `url` is null until the file is on the server (see loadMedia). */
export type BubbleMedia = {
  type: BubbleMediaType;
  url: string | null;
  mimetype: string | null;
  filename: string | null;
  /** True while the dashboard is asking the gateway to fetch this file. */
  loading?: boolean;
};

export type Bubble =
  | {
      id: string;
      kind: "text";
      from: "me" | "them";
      /** Text, caption, or a label for non-text content. */
      text: string;
      time: string;
      /** Group messages: who sent it. */
      sender?: string | null;
      media?: BubbleMedia;
      /** Optimistic bubbles show a pending marker until the send resolves. */
      pending?: boolean;
    }
  | { id: string; kind: "promo"; time: string };
