import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  FULLSCREEN_ENTER_LABEL,
  FULLSCREEN_ENTER_NAME,
  FULLSCREEN_EXIT_LABEL,
  FULLSCREEN_EXIT_NAME,
  attachStageFullscreen,
  type OrientationScreen,
} from './stage-fullscreen.ts';

type Listener = (event: Event) => void;

function styleMap() {
  const values = new Map<string, string>();
  return {
    values,
    setProperty(name: string, value: string) {
      values.set(name, value);
    },
    getPropertyValue(name: string) {
      return values.get(name) ?? '';
    },
    removeProperty(name: string) {
      values.delete(name);
    },
  };
}

function fakeStage(width: number, height: number) {
  const style = styleMap();
  const children: ReturnType<typeof fakeButton>[] = [];
  const stage = {
    clientWidth: width,
    clientHeight: height,
    style,
    dataset: {} as DOMStringMap,
    children,
    contains(node: unknown) {
      return node === stage;
    },
    append(node: ReturnType<typeof fakeButton>) {
      children.push(node);
    },
    requestFullscreen: undefined as (() => Promise<void>) | undefined,
    webkitRequestFullscreen: undefined as (() => Promise<void>) | undefined,
  };
  return stage;
}

function fakeButton() {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Listener[]>();
  return {
    type: '',
    textContent: '',
    dataset: {} as DOMStringMap,
    style: styleMap(),
    removed: false,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener() {},
    click() {
      for (const listener of listeners.get('click') ?? []) listener(new Event('click'));
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type));
    },
    remove() {
      this.removed = true;
    },
  };
}

function fakeDocument() {
  const listeners = new Map<string, Listener[]>();
  const bodyChildren: ReturnType<typeof fakeButton>[] = [];
  const doc = {
    fullscreenElement: null as object | null,
    webkitFullscreenElement: null as object | null,
    documentElement: { style: styleMap() },
    body: {
      style: styleMap(),
      append(node: ReturnType<typeof fakeButton>) {
        bodyChildren.push(node);
      },
    },
    exitCalls: 0,
    async exitFullscreen() {
      doc.exitCalls += 1;
      doc.fullscreenElement = null;
      doc.webkitFullscreenElement = null;
    },
    createElement(tag: string) {
      assert.equal(tag, 'button');
      return fakeButton();
    },
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener));
    },
    emit(type: string, event: Event = new Event(type)) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    bodyChildren,
  };
  return doc;
}

function escapeEvent() {
  let prevented = false;
  return {
    key: 'Escape',
    prevented: () => prevented,
    preventDefault() {
      prevented = true;
    },
  };
}

function attach(width = 320, height = 180, screen: OrientationScreen | null = { orientation: {} }) {
  const stage = fakeStage(width, height);
  const button = fakeButton();
  const doc = fakeDocument();
  const controls = attachStageFullscreen(stage as unknown as HTMLElement, button as unknown as HTMLButtonElement, {
    doc: doc as unknown as Document,
    screen,
  });
  return { stage, button, doc, controls };
}

function css(stage: ReturnType<typeof fakeStage>, name: string) {
  return stage.style.getPropertyValue(name);
}

describe('stage fullscreen fallback', () => {
  it('pins the stage over the page when the document has no fullscreen API', async () => {
    const { stage, button, doc, controls } = attach();
    await controls.toggle();

    assert.equal(css(stage, 'position'), 'fixed');
    assert.equal(css(stage, 'inset'), '0');
    assert.equal(css(stage, 'width'), '100dvw');
    assert.equal(css(stage, 'height'), '100dvh');
    assert.equal(css(stage, 'z-index'), '900');
    assert.equal(css(stage, 'padding-top'), 'env(safe-area-inset-top)');
    assert.equal(css(stage, 'padding-right'), 'env(safe-area-inset-right)');
    assert.equal(css(stage, 'padding-bottom'), 'env(safe-area-inset-bottom)');
    assert.equal(css(stage, 'padding-left'), 'env(safe-area-inset-left)');
    assert.equal(doc.documentElement.style.getPropertyValue('overflow'), 'hidden');
    assert.equal(doc.body.style.getPropertyValue('overflow'), 'hidden');
    assert.equal(button.textContent, FULLSCREEN_EXIT_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_EXIT_NAME);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(doc.bodyChildren.length, 0);

    const exit = stage.children[0];
    assert.ok(exit);
    assert.equal(exit.dataset.fullscreenExit, '1');
    assert.equal(exit.textContent, '×');
    assert.equal(exit.getAttribute('aria-label'), FULLSCREEN_EXIT_NAME);
    assert.equal(exit.removed, false);
    assert.equal(exit.style.getPropertyValue('position'), 'absolute');
    assert.equal(exit.style.getPropertyValue('z-index'), '2');

    const esc = escapeEvent();
    doc.emit('keydown', esc as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(esc.prevented(), true);
    assert.equal(css(stage, 'position'), '');
    assert.equal(doc.body.style.getPropertyValue('overflow'), '');
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.ok(button.focusCount >= 1);
    assert.equal(exit.removed, true);
    controls.destroy();
  });

  it('leaves fullscreen from a pointer release when the click never arrives', async () => {
    const { stage, button, doc, controls } = attach();
    stage.requestFullscreen = async () => {
      doc.fullscreenElement = stage;
    };
    await controls.toggle();
    const exit = stage.children[0];
    assert.ok(exit);
    exit.emit('pointerup');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(doc.exitCalls, 1);
    exit.emit('touchend');
    exit.emit('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(doc.exitCalls, 1);
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
    assert.equal(button.focusCount, 1);
    assert.equal(exit.removed, true);
    controls.destroy();
  });

  it('leaves immersive mode from the exit button', async () => {
    const { stage, button, doc, controls } = attach();
    await controls.toggle();
    stage.children[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(css(stage, 'position'), '');
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(doc.body.style.getPropertyValue('overflow'), '');
    controls.destroy();
  });

  it('uses CSS when requestFullscreen rejects and webkitRequestFullscreen is missing', async () => {
    const { stage, doc, controls } = attach();
    stage.requestFullscreen = () => Promise.reject(new Error('not allowed'));
    await controls.toggle();
    assert.equal(css(stage, 'position'), 'fixed');
    assert.equal(doc.bodyChildren.length, 0);
    assert.equal(stage.children.length, 1);
    controls.destroy();
  });

  it('stays native when requestFullscreen rejects and webkitRequestFullscreen enters', async () => {
    const { stage, button, doc, controls } = attach();
    stage.requestFullscreen = () => Promise.reject(new Error('missing'));
    stage.webkitRequestFullscreen = async () => {
      doc.webkitFullscreenElement = stage;
    };
    await controls.toggle();
    assert.equal(css(stage, 'position'), '');
    assert.equal(doc.bodyChildren.length, 0);
    assert.equal(stage.children.length, 1);
    assert.equal(stage.children[0]?.style.getPropertyValue('position'), 'absolute');
    assert.equal(button.textContent, FULLSCREEN_EXIT_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_EXIT_NAME);

    doc.webkitFullscreenElement = null;
    doc.emit('webkitfullscreenchange');
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(stage.children[0]?.removed, true);
    assert.ok(button.focusCount >= 1);
    controls.destroy();
  });

  it('Escape leaves native fullscreen and the browser exit event agrees', async () => {
    const { stage, button, doc, controls } = attach();
    stage.requestFullscreen = async () => {
      doc.fullscreenElement = stage;
    };
    await controls.toggle();
    const esc = escapeEvent();
    doc.emit('keydown', esc as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(esc.prevented(), true);
    assert.ok(doc.exitCalls >= 1);
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
    assert.ok(button.focusCount >= 1);
    controls.destroy();
  });

  it('returns the toolbar to Fullscreen when the browser leaves native fullscreen', async () => {
    const { stage, button, doc, controls } = attach();
    stage.requestFullscreen = async () => {
      doc.fullscreenElement = stage;
    };
    await controls.toggle();
    assert.equal(button.textContent, FULLSCREEN_EXIT_LABEL);
    assert.equal(css(stage, 'height'), '');

    doc.fullscreenElement = null;
    doc.emit('fullscreenchange');
    assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
    assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
    assert.equal(stage.children[0]?.removed, true);
    assert.ok(button.focusCount >= 1);
    controls.destroy();
  });

  it('keeps the exit button inside the stage for both native tiers and leaves when it is clicked', async () => {
    for (const tier of ['standard', 'webkit'] as const) {
      const { stage, button, doc, controls } = attach();
      if (tier === 'standard') {
        stage.requestFullscreen = async () => {
          doc.fullscreenElement = stage;
        };
      } else {
        stage.requestFullscreen = () => Promise.reject(new Error('missing'));
        stage.webkitRequestFullscreen = async () => {
          doc.webkitFullscreenElement = stage;
        };
      }
      await controls.toggle();
      assert.equal(css(stage, 'position'), '');
      assert.equal(doc.bodyChildren.length, 0);
      const exit = stage.children[0];
      assert.ok(exit);
      assert.equal(exit.dataset.fullscreenExit, '1');
      assert.equal(exit.getAttribute('aria-label'), FULLSCREEN_EXIT_NAME);
      assert.equal(exit.style.getPropertyValue('z-index'), '2');
      assert.equal(button.focusCount, 0);

      exit.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(doc.exitCalls >= 1);
      assert.equal(button.textContent, FULLSCREEN_ENTER_LABEL);
      assert.equal(button.getAttribute('aria-label'), FULLSCREEN_ENTER_NAME);
      assert.equal(exit.removed, true);
      assert.ok(button.focusCount >= 1);
      controls.destroy();
    }
  });

  it('locks landscape from the stage box and ignores a rejected lock', async () => {
    const calls: string[] = [];
    const screen: OrientationScreen = {
      orientation: {
        lock: async (orientation) => {
          calls.push(orientation);
          throw new Error('unsupported');
        },
      },
    };
    const landscape = attach(360, 202, screen);
    await landscape.controls.toggle();
    assert.deepEqual(calls, ['landscape']);
    assert.equal(css(landscape.stage, 'position'), 'fixed');
    landscape.controls.destroy();

    const portraitCalls: string[] = [];
    const portrait = attach(200, 360, {
      orientation: {
        lock: async (orientation) => {
          portraitCalls.push(orientation);
        },
      },
    });
    await portrait.controls.toggle();
    assert.deepEqual(portraitCalls, []);
    portrait.controls.destroy();

    const unlaid = attach(0, 0, screen);
    await unlaid.controls.toggle();
    assert.deepEqual(calls, ['landscape']);
    unlaid.controls.destroy();
  });
});

describe('fullscreen is a shared player feature', () => {
  it('the play page delegates to the module and every game iframe allows fullscreen', () => {
    const page = fs.readFileSync(new URL('../pages/play/[slug].astro', import.meta.url), 'utf8');
    const player = fs.readFileSync(new URL('./player.ts', import.meta.url), 'utf8');
    assert.match(page, /attachStageFullscreen\(stage,/);
    assert.doesNotMatch(page, /stage\.requestFullscreen/);
    assert.match(player, /gyroscope; fullscreen/);
    assert.match(player, /allowFullscreen = true/);
    assert.match(player, /data-fullscreen-exit/);
    assert.equal(player.includes('inputSupport'), false);
  });
});
