import { describe, expect, it } from 'vitest';
import {
  REACTION_MARKER_INSTRUCTION,
  stripReactionMarker,
} from '../src/modules/aichat/reaction-marker.js';

describe('stripReactionMarker', () => {
  it('extracts emoji and strips the marker line', () => {
    const result = stripReactionMarker(
      'こんにちは！今日もいい天気ですね。\n\n[[REACTION: 😊]]'
    );
    expect(result.reaction).toBe('😊');
    expect(result.cleaned).toBe('こんにちは！今日もいい天気ですね。');
  });

  it('returns null reaction for none', () => {
    const result = stripReactionMarker('返信です\n[[REACTION: none]]');
    expect(result.reaction).toBeNull();
    expect(result.cleaned).toBe('返信です');
  });

  it('returns original text when no marker is present', () => {
    const result = stripReactionMarker('普通の返信です');
    expect(result.reaction).toBeNull();
    expect(result.cleaned).toBe('普通の返信です');
  });

  it('handles marker with surrounding whitespace', () => {
    const result = stripReactionMarker('本文  \n[[REACTION: :blobcatcat:]]  ');
    expect(result.reaction).toBe(':blobcatcat:');
    expect(result.cleaned).toBe('本文');
  });

  it('only strips the final marker occurrence', () => {
    const result = stripReactionMarker(
      '[[REACTION: 😊]] を文中に含む本文\n[[REACTION: ✨]]'
    );
    expect(result.reaction).toBe('✨');
    expect(result.cleaned).toBe('[[REACTION: 😊]] を文中に含む本文');
  });

  it('treats empty marker value as no reaction', () => {
    const result = stripReactionMarker('本文\n[[REACTION:]]');
    expect(result.reaction).toBeNull();
    expect(result.cleaned).toBe('本文');
  });
});

describe('REACTION_MARKER_INSTRUCTION', () => {
  it('instructs the marker format in Japanese', () => {
    expect(REACTION_MARKER_INSTRUCTION).toContain('[[REACTION:');
    expect(REACTION_MARKER_INSTRUCTION).toContain('none');
  });
});
