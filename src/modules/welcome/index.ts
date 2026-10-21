import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import type Stream from '@/stream.js';

export default class extends Module {
  public readonly name = 'welcome';

  private tl?: ReturnType<Stream['useSharedConnection']>;

  @bindThis
  public install() {
    this.tl = this.ai.connection.useSharedConnection('localTimeline');

    this.tl.on('note', this.onLocalNote);

    return {};
  }

  protected onDispose(): void {
    this.tl?.dispose();
  }

  @bindThis
  private onLocalNote(note: any) {
    if (note.isFirstNote) {
      this.later(3000, () => {
        this.ai.api('notes/create', {
          renoteId: note.id,
        });
      });

      this.later(5000, () => this.ai.reactions.reactForce(note.id, 'congrats'));
    }
  }
}
