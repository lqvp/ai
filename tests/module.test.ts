import { describe, expect, it } from 'vitest';
import Module from '../src/module.js';

class TestModule extends Module {
  public readonly name = 'test';
  public installed = 0;

  public install() {
    this.installed += 1;
    return {};
  }

  public async mentionHook() {
    return true;
  }

  public async timeoutCallback() {
    return undefined;
  }
}

class DisabledModule extends Module {
  public readonly name = 'disabled';
  public install() {
    return false as const;
  }
}

describe('Module.getHooks', () => {
  it('auto-registers hooks defined on the class', () => {
    const module = new TestModule();
    const hooks = module.getHooks();
    expect(typeof hooks.mentionHook).toBe('function');
    expect(typeof hooks.timeoutCallback).toBe('function');
  });

  it('returns no hooks when install() returns false', () => {
    const module = new DisabledModule();
    expect(module.getHooks()).toEqual({});
  });
});
