export interface WeatherInfo {
  place: string;
  dateLabel: string;
  telop: string;
  tempMin: string | null;
  tempMax: string | null;
  rain: {
    T00_06: string;
    T06_12: string;
    T12_18: string;
    T18_24: string;
  } | null;
  additionalMessage?: string;
  greeting?: string;
}

export interface RawForecast {
  dateLabel: string;
  telop: string;
  temperature?: {
    min?: { celsius?: string };
    max?: { celsius?: string };
  };
  chanceOfRain?: WeatherInfo['rain'];
}

export interface RawWeatherData {
  title: string;
  forecasts: RawForecast[];
  location?: {
    area: string;
    prefecture: string;
    district: string;
    city: string;
  };
  error?: string;
}
