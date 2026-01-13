
export enum Role {
  USER = 'user',
  MODEL = 'model'
}

export interface Message {
  role: Role;
  text: string;
  timestamp: Date;
  isAudioPlaying?: boolean;
}

export interface ChatSession {
  id: string;
  messages: Message[];
}
