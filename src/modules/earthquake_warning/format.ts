/**
 * earthquake_warning の整形処理。
 * 純粋関数のみで構成し、ユニットテストできるようにしている。
 */

import type {
  P2PQuakeTsunamiData,
  TsunamiArea,
  WolfxEarthquakeData,
} from './types.js';

export function generateTsunamiMessage(data: P2PQuakeTsunamiData): string {
  const issueTime = formatP2PDateTime(data.issue.time || data.time);
  const issueSource = data.issue.source || '気象庁';

  if (data.cancelled) {
    return (
      `🌊 津波情報\n\n` +
      `${issueTime}、${issueSource}の津波予報は解除されました。\n` +
      `念のため沿岸部では安全確認を続けてください。`
    );
  }

  const areas = Array.isArray(data.areas) ? data.areas : [];
  const gradeCounts = new Map<string, number>();

  for (const area of areas) {
    const grade = convertTsunamiGrade(area.grade);
    gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);
  }

  const gradeSummary = Array.from(gradeCounts.entries())
    .map(([grade, count]) => `${grade} ${count}地域`)
    .join(' / ');

  let message = '🌊 津波情報を受信しました\n\n';
  message += `${issueTime}、${issueSource}から津波予報が発表されました。\n`;

  if (gradeSummary) {
    message += `区分: ${gradeSummary}\n`;
  }

  if (areas.length === 0) {
    message += '\n対象地域の詳細は確認できませんでした。';
    return message;
  }

  message += '\n対象地域:\n';
  const displayAreas = areas.slice(0, 6);

  for (const area of displayAreas) {
    message += `・${formatTsunamiArea(area)}\n`;
  }

  if (areas.length > displayAreas.length) {
    message += `・他${areas.length - displayAreas.length}地域\n`;
  }

  message += '\n海岸や河口付近から離れ、自治体の避難情報に従ってください。';
  return message;
}

export function formatTsunamiArea(area: TsunamiArea): string {
  const name = area.name || '名称不明';
  const grade = convertTsunamiGrade(area.grade);
  const details: string[] = [];

  if (area.immediate) {
    details.push('直ちに津波来襲と予測');
  }

  if (area.firstHeight?.condition) {
    details.push(area.firstHeight.condition);
  } else if (area.firstHeight?.arrivalTime) {
    details.push(`第1波: ${area.firstHeight.arrivalTime}`);
  }

  if (area.maxHeight?.description) {
    details.push(`予想高さ: ${area.maxHeight.description}`);
  } else if (typeof area.maxHeight?.value === 'number') {
    details.push(`予想高さ: ${area.maxHeight.value}m`);
  }

  if (details.length === 0) {
    return `${name} (${grade})`;
  }

  return `${name} (${grade}) ${details.join(' / ')}`;
}

export function convertTsunamiGrade(grade?: string): string {
  if (grade === 'MajorWarning') return '大津波警報';
  if (grade === 'Warning') return '津波警報';
  if (grade === 'Watch') return '津波注意報';
  return '不明';
}

export function formatP2PDateTime(value: string): string {
  const parsed = new Date(value);

  if (isNaN(parsed.getTime())) {
    return `${value} JST`;
  }

  return formatJSTDateTime(parsed);
}

export function convertIntensityToNumber(
  intensity: string,
  log?: (message: string) => void
): number {
  // 入力検証
  if (!intensity || typeof intensity !== 'string') {
    log?.(`無効な震度文字列: ${intensity}`);
    return 0;
  }

  // 震度文字列を数値に変換 (互換性を保持しつつ処理)
  if (intensity.includes('7')) return 7;
  if (intensity.includes('6+') || intensity.includes('6強')) return 6;
  if (intensity.includes('6-') || intensity.includes('6弱')) return 6;
  if (intensity.includes('5+') || intensity.includes('5強')) return 5;
  if (intensity.includes('5-') || intensity.includes('5弱')) return 5;
  if (intensity.includes('4')) return 4;
  if (intensity.includes('3')) return 3;
  if (intensity.includes('2')) return 2;
  if (intensity.includes('1')) return 1;
  return 0;
}

export function convertIntensityDisplay(intensity: string): string {
  // -/+ を 弱/強 に変換して表示する (元のデータは変更しない)
  return intensity
    .replace('5-', '5弱')
    .replace('5+', '5強')
    .replace('6-', '6弱')
    .replace('6+', '6強');
}

export function formatJSTDateTime(date: Date): string {
  return (
    date.toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' JST'
  );
}

export function randomChoice(items: string[]): string {
  const r = Math.floor(Math.random() * items.length);
  return items[r];
}

export function generateEarthquakeMessage(
  data: WolfxEarthquakeData,
  isInitial: boolean,
  previous?: WolfxEarthquakeData
): string {
  let message = '';
  const intensityValue = convertIntensityToNumber(data.MaxIntensity);

  // 初回メッセージの場合のみ、震度に応じた反応を追加
  if (isInitial) {
    if (intensityValue < 4) {
      message += randomChoice([
        'ゆれ……',
        'ゆれ?',
        '地震ですかね？',
        '揺れそうな気がします！',
        'ゆ……？',
        'ゆ？',
        'ぽよん！',
        ':blobbounce:',
      ]);
    } else if (intensityValue === 4) {
      message += randomChoice(['ゆれ……！', '地震です！！', '結構揺れます！']);
    } else if (intensityValue === 5) {
      message += randomChoice([
        'ゆれます……！　おおきいです！！',
        'かなり揺れます！',
      ]);
    } else if (intensityValue === 6) {
      message += randomChoice(['大地震です！！', 'めちゃくちゃ揺れます！']);
    } else if (intensityValue >= 7) {
      message += randomChoice(['！！　大地震です！！']);
    }

    message += '\n\n';
  }

  const announcedTime = formatJSTDateTime(new Date(data.AnnouncedTime));
  message += `${announcedTime}、地震速報を受信しました！\n`;
  message += `${data.Hypocenter}付近で震度${convertIntensityDisplay(
    data.MaxIntensity
  )}の揺れが予想されます！\n`;
  message += `マグニチュードは${data.Magunitude}、震源の深さは約${data.Depth}kmです。\n`;

  // 警報の場合は特別な表示
  if (data.isWarn) {
    message += `\n⚠️ これは警報です！強い揺れに注意してください ⚠️\n`;
  }

  // 震源精度情報がある場合
  if (data.Accuracy) {
    const accuracyInfo: string[] = [];
    if (data.Accuracy.Epicenter && data.Accuracy.Epicenter !== '不明') {
      accuracyInfo.push(`震源: ${data.Accuracy.Epicenter}`);
    }
    if (data.Accuracy.Magnitude && data.Accuracy.Magnitude !== '不明') {
      accuracyInfo.push(`M: ${data.Accuracy.Magnitude}`);
    }
    if (data.Accuracy.Depth && data.Accuracy.Depth !== '不明') {
      accuracyInfo.push(`深さ: ${data.Accuracy.Depth}`);
    }

    if (accuracyInfo.length > 0) {
      message += `\n精度情報: ${accuracyInfo.join('、')}\n`;
    }
  }

  // 震度変更情報がある場合
  if (data.MaxIntChange && data.MaxIntChange.String) {
    // 震度表示を変換
    const convertedString = data.MaxIntChange.String.replace(
      '震度5-',
      '震度5弱'
    )
      .replace('震度5+', '震度5強')
      .replace('震度6-', '震度6弱')
      .replace('震度6+', '震度6強');

    message += `\n震度情報が変更されました: ${convertedString}\n`;
    if (data.MaxIntChange.Reason) {
      message += `変更理由: ${data.MaxIntChange.Reason}\n`;
    }
  }

  // 更新情報の追加（初回以外で表示）
  if (!isInitial && previous) {
    const lastData = previous;
    const updates: string[] = [];

    // マグニチュードの変化
    if (lastData.Magunitude !== data.Magunitude) {
      const diff = data.Magunitude - lastData.Magunitude;
      const direction = diff > 0 ? '上方' : '下方';
      updates.push(
        `マグニチュード: ${lastData.Magunitude} → ${data.Magunitude} (${direction}修正)`
      );
    }

    // 震源の深さの変化
    if (lastData.Depth !== data.Depth) {
      const diff = data.Depth - lastData.Depth;
      updates.push(
        `震源の深さ: ${lastData.Depth}km → ${data.Depth}km (${
          diff > 0 ? '深く' : '浅く'
        }修正)`
      );
    }

    // 震度の変化（MaxIntChangeとは別に、単純な前回との比較）
    if (lastData.MaxIntensity !== data.MaxIntensity) {
      updates.push(
        `震度: ${convertIntensityDisplay(
          lastData.MaxIntensity
        )} → ${convertIntensityDisplay(data.MaxIntensity)}`
      );
    }

    if (updates.length > 0) {
      message += '\n📊 前回からの更新情報:\n';
      updates.forEach((update) => {
        message += `・${update}\n`;
      });
    }
  }

  // 警戒地域情報がある場合
  if (data.WarnArea && data.WarnArea.length > 0) {
    message += `\n警戒地域:\n`;
    for (let i = 0; i < Math.min(data.WarnArea.length, 5); i++) {
      // 最大5地域まで表示
      const area = data.WarnArea[i];
      message += `- ${area.Chiiki}: 震度${convertIntensityDisplay(
        area.Shindo1
      )}～${convertIntensityDisplay(area.Shindo2)} (${area.Type})\n`;
    }
    if (data.WarnArea.length > 5) {
      message += `他${data.WarnArea.length - 5}地域...\n`;
    }
  }

  return message;
}
