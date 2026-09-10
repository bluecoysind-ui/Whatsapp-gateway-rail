/** Shapes the gateway UI renders. Data comes from the backend at runtime. */

export type ChatKind = "dm" | "group";

export type ChatPreview = {
  id: string;
  name: string;
  preview: string;
  time: string;
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

export type Bubble =
  | { id: string; kind: "text"; from: "me" | "them"; text: string; time: string }
  | { id: string; kind: "promo"; time: string };
