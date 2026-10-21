/**
 * earthquake_warning モジュールの型定義。
 */

// Wolfx APIからの地震データの型定義
export interface WolfxEarthquakeData {
  type: string;
  Title: string;
  CodeType: string;
  Issue: {
    Source: string;
    Status: string;
  };
  EventID: string;
  Serial: number;
  AnnouncedTime: string;
  OriginTime: string;
  Hypocenter: string;
  Latitude: number;
  Longitude: number;
  Magunitude: number;
  Depth: number;
  MaxIntensity: string;
  Accuracy: {
    Epicenter: string;
    Depth: string;
    Magnitude: string;
  };
  MaxIntChange?: {
    String: string;
    Reason: string;
  };
  WarnArea?: {
    Chiiki: string;
    Shindo1: string;
    Shindo2: string;
    Time: string;
    Type: string;
    Arrive: boolean;
  }[];
  isSea: boolean;
  isTraining: boolean;
  isAssumption: boolean;
  isWarn: boolean;
  isFinal: boolean;
  isCancel: boolean;
  OriginalText: string;
}

// WebSocketからのハートビートデータの型定義
export interface HeartbeatData {
  type: string;
  ver: string;
  id: string;
  timestamp: number;
}

export interface P2PQuakeTsunamiData {
  id: string;
  code: number;
  time: string;
  cancelled: boolean;
  issue: {
    source?: string;
    time: string;
    type: string;
  };
  areas?: TsunamiArea[];
}

export interface TsunamiArea {
  grade?: string;
  immediate?: boolean;
  name?: string;
  firstHeight?: {
    arrivalTime?: string;
    condition?: string;
  };
  maxHeight?: {
    description?: string;
    value?: number;
  };
}

// 地震イベントを追跡するための型定義
export interface EarthquakeEvent {
  eventId: string;
  initialPostId: string;
  lastUpdate: number;
  reportCount: number;
  isFinal: boolean;
  isCancel: boolean;
  connectionId: string;
}
