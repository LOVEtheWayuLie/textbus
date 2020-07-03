import { auditTime, distinctUntilChanged, map, sampleTime, tap } from 'rxjs/operators';
import { from, fromEvent, merge, Observable, of, Subject, Subscription, zip } from 'rxjs';

import {
  BackboneTemplate,
  BranchTemplate,
  Commander,
  Contents,
  EventType,
  Fragment,
  InlineFormatter,
  LeafTemplate,
  Lifecycle,
  Parser,
  RangePath,
  Renderer,
  TBRange,
  TBRangePosition,
  TBSelection,
  TemplateTranslator,
  VElement
} from './core/_api';
import { Viewer } from './viewer/viewer';
import { ContextMenu, EventDelegate, HighlightState, Toolbar, ToolConfig, ToolFactory } from './toolbar/_api';
import { BlockTemplate, SingleTagTemplate } from './templates/_api';
import { Input, KeymapAction } from './input/input';
import { StatusBar } from './status-bar/status-bar';

export interface Snapshot {
  contents: Fragment;
  paths: RangePath[];
}

export interface EditorOptions {
  /** 设置主题 */
  theme?: string;
  /** 设备宽度 */
  deviceWidth?: string;
  /** 设置最大历史栈 */
  historyStackSize?: number;
  /** 设置模板转换器 */
  templateTranslators?: TemplateTranslator[];
  /** 设置格式转换器 */
  formatters?: InlineFormatter[];
  /** 工具条配置 */
  toolbar?: (ToolFactory | ToolFactory[])[];
  /** 配置生命周期勾子 */
  hooks?: Lifecycle[];
  /** 配置编辑器的默认样式 */
  styleSheets?: string[];

  /** 当某些工具需要上传资源时的调用函数，调用时会传入上传资源的类型，如 image、video、audio等，该函数返回一个字符串，作为资源的 url 地址 */
  uploader?(type: string): (string | Promise<string> | Observable<string>);

  /** 设置初始化 TBus 时的默认内容 */
  contents?: string;
}

export enum CursorMoveDirection {
  Left,
  Right,
  Up,
  Down
}

export class Editor implements EventDelegate {
  readonly onReady: Observable<void>;
  readonly onChange: Observable<void>;

  get canBack() {
    return this.historySequence.length > 0 && this.historyIndex > 0;
  }

  get canForward() {
    return this.historySequence.length > 0 && this.historyIndex < this.historySequence.length - 1;
  }

  readonly elementRef = document.createElement('div');

  private readonly frameContainer = document.createElement('div');
  private readonly container: HTMLElement;

  private viewer: Viewer;
  private parser: Parser;
  private toolbar: Toolbar;
  private input: Input;
  private renderer = new Renderer();
  private statusBar = new StatusBar();
  private contextMenu = new ContextMenu(this.renderer);

  private readyState = false;
  private tasks: Array<() => void> = [];

  private historySequence: Array<Snapshot> = [];
  private historyIndex = 0;
  private readonly historyStackSize: number;

  private nativeSelection: Selection;
  private selection: TBSelection;

  private defaultHTML = '<p><br></p>';
  private rootFragment: Fragment;
  private sub: Subscription;
  private readyEvent = new Subject<void>();
  private changeEvent = new Subject<void>();

  private selectionSnapshot: TBSelection;
  private fragmentSnapshot: Fragment;

  private oldCursorPosition: { left: number, top: number } = null;
  private cleanOldCursorTimer: any;

  private onUserWrite: Observable<void>;
  private userWriteEvent = new Subject<void>();


  constructor(public selector: string | HTMLElement, public options: EditorOptions) {
    this.onUserWrite = this.userWriteEvent.asObservable();
    if (typeof selector === 'string') {
      this.container = document.querySelector(selector);
    } else {
      this.container = selector;
    }
    this.historyStackSize = options.historyStackSize || 50;
    this.onReady = this.readyEvent.asObservable();
    this.onChange = this.changeEvent.asObservable();

    this.parser = new Parser(options);

    this.frameContainer.classList.add('tbus-frame-container');

    this.toolbar = new Toolbar(this, this.contextMenu, options.toolbar);
    this.viewer = new Viewer(options.styleSheets);
    const deviceWidth = options.deviceWidth || '100%';
    this.frameContainer.style.padding = deviceWidth === '100%' ? '' : '20px';
    this.statusBar.device.update(deviceWidth);
    this.viewer.setViewWidth(deviceWidth);

    this.statusBar.device.onChange.subscribe(value => {
      this.frameContainer.style.padding = value === '100%' ? '' : '20px';
      this.viewer.setViewWidth(value);
    });

    zip(from(this.writeContents(options.contents || this.defaultHTML)), this.viewer.onReady).subscribe(result => {
      this.readyState = true;
      this.rootFragment = this.parser.parse(result[0]);
      this.render();
      this.input = new Input(this.viewer.contentDocument);
      this.viewer.elementRef.append(this.input.elementRef);

      this.setup();
      this.readyEvent.next();
    });

    this.elementRef.appendChild(this.toolbar.elementRef);
    this.elementRef.appendChild(this.frameContainer);
    this.frameContainer.appendChild(this.viewer.elementRef);
    this.elementRef.append(this.statusBar.elementRef);
    this.elementRef.classList.add('tbus-container');
    if (options.theme) {
      this.elementRef.classList.add('tbus-theme-' + options.theme);
    }
    this.container.appendChild(this.elementRef);

    this.listenUserWriteEvent();

  }

  setContents(html: string) {
    this.run(() => {
      this.writeContents(html).then(el => {
        this.rootFragment = this.parser.parse(el);
        this.render();
      });
    })
  }

  dispatchEvent(type: string): Observable<string> {
    if (typeof this.options.uploader === 'function') {
      const result = this.options.uploader(type);
      if (result instanceof Observable) {
        return result;
      } else if (result instanceof Promise) {
        return from(result);
      } else if (typeof result === 'string') {
        return of(result);
      }
    }
    return of('');
  }

  getPreviousSnapshot() {
    if (this.canBack) {
      this.historyIndex--;
      this.historyIndex = Math.max(0, this.historyIndex);
      return Editor.cloneHistoryData(this.historySequence[this.historyIndex]);
    }
    return null;
  }

  getNextSnapshot() {
    if (this.canForward) {
      this.historyIndex++;
      return Editor.cloneHistoryData(this.historySequence[this.historyIndex]);
    }
    return null;
  }

  getContents() {
    const contents = (this.options.hooks || []).reduce((previousValue, currentValue) => {
      if (typeof currentValue.onOutput === 'function') {
        return currentValue.onOutput(previousValue);
      }
      return previousValue;
    }, this.renderer.renderToString(this.rootFragment));
    return {
      styleSheets: this.options.styleSheets,
      contents
    };
  }

  getJSONLiteral() {
    return {
      styleSheets: this.options.styleSheets,
      contents: this.renderer.renderToJSON(this.rootFragment)
    };
  }

  registerKeymap(action: KeymapAction) {
    this.run(() => {
      this.input.keymap(action);
    });
  }

  private write(selection: TBSelection) {
    const startIndex = this.selectionSnapshot.firstRange.startIndex;
    const commonAncestorFragment = selection.commonAncestorFragment;
    const fragmentSnapshot = this.fragmentSnapshot.clone();

    commonAncestorFragment.delete(0);
    fragmentSnapshot.sliceContents(0).forEach(item => commonAncestorFragment.append(item));
    fragmentSnapshot.getFormatRanges().forEach(f => commonAncestorFragment.apply(f, true, false));

    let index = 0;
    this.input.input.value.replace(/\n+|[^\n]+/g, (str) => {
      if (/\n+/.test(str)) {
        for (let i = 0; i < str.length; i++) {
          const s = new SingleTagTemplate('br');
          commonAncestorFragment.insert(s, index + startIndex);
          index++;
        }
      } else {
        commonAncestorFragment.insert(str, startIndex + index);
        index += str.length;
      }
      return str;
    });

    selection.firstRange.startIndex = selection.firstRange.endIndex = startIndex + this.input.input.selectionStart;
    const last = commonAncestorFragment.getContentAtIndex(commonAncestorFragment.contentLength - 1);
    if (startIndex + this.input.input.selectionStart === commonAncestorFragment.contentLength &&
      last instanceof SingleTagTemplate && last.tagName === 'br') {
      commonAncestorFragment.append(new SingleTagTemplate('br'));
    }
    this.userWriteEvent.next();
  }

  private setup() {
    merge(...['selectstart', 'mousedown'].map(type => fromEvent(this.viewer.contentDocument, type)))
      .subscribe(() => {
        this.nativeSelection = this.viewer.contentDocument.getSelection();
        this.nativeSelection.removeAllRanges();
      });
    (this.options.hooks || []).forEach(hooks => {
      if (typeof hooks.setup === 'function') {
        hooks.setup(this.renderer, this.viewer.contentDocument, this.viewer.contentWindow, this.viewer.elementRef);
      }
    })
    fromEvent(this.viewer.contentDocument, 'selectionchange').pipe(tap(() => {
      this.selection = this.options.hooks.reduce((selection, lifecycle) => {
        if (typeof lifecycle.onSelectionChange === 'function') {
          lifecycle.onSelectionChange(this.renderer, selection, this.viewer.contentDocument);
        }
        return selection;
      }, new TBSelection(this.viewer.contentDocument, this.renderer));
      this.input.updateStateBySelection(this.nativeSelection);
    }), auditTime(100), tap(() => {
      const event = document.createEvent('Event');
      event.initEvent('click', true, true);
      this.elementRef.dispatchEvent(event);
      this.toolbar.updateHandlerState(this.selection, this.renderer);
    }), map(() => {
      return this.nativeSelection.focusNode;
    }), distinctUntilChanged()).subscribe(node => {
      this.statusBar.paths.update(node);
    })

    this.toolbar.onAction.subscribe(config => {
      if (this.selection) {
        this.apply(config.config, config.instance.commander);
        if (config.instance.commander.recordHistory) {
          this.recordSnapshot();
          this.listenUserWriteEvent();
        }
      }
    });
    this.input.events.onFocus.subscribe(() => {
      this.recordSnapshotFromEditingBefore();
    })
    this.input.events.onInput.subscribe(() => {
      const selection = this.selection;
      const collapsed = selection.collapsed;
      let isNext = true;
      (this.options.hooks || []).forEach(lifecycle => {
        if (typeof lifecycle.onInput === 'function') {
          if (lifecycle.onInput(this.renderer, selection) === false) {
            isNext = false;
          } else {
            if (!selection.collapsed) {
              throw new Error('输入前选区必须闭合！');
            }
          }
        }
      })
      if (isNext) {
        if (!collapsed) {
          this.recordSnapshotFromEditingBefore(true);
        }
        this.write(selection);
      }
      this.render();
      selection.restore();
      this.input.updateStateBySelection(this.nativeSelection);
    })
    this.input.events.onPaste.subscribe(() => {
      const div = document.createElement('div');
      div.style.cssText = 'width:10px; height:10px; overflow: hidden; position: fixed; left: -9999px';
      div.contentEditable = 'true';
      document.body.appendChild(div);
      div.focus();
      setTimeout(() => {
        const fragment = this.parser.parse(div);
        const contents = new Contents();
        fragment.sliceContents(0).forEach(i => contents.append(i));
        document.body.removeChild(div);
        let isNext = true;
        (this.options.hooks || []).forEach(lifecycle => {
          if (typeof lifecycle.onPaste === 'function') {
            if (lifecycle.onPaste(contents, this.renderer, this.selection) === false) {
              isNext = false;
            }
          }
        })
        if (isNext) {
          this.paste(contents);
        }
      });
    });

    this.input.events.addKeymap({
      keymap: {
        key: 'Enter'
      },
      action: () => {
        const focusNode = this.nativeSelection.focusNode;
        let el = focusNode.nodeType === 3 ? focusNode.parentNode : focusNode;
        const vElement = this.renderer.getVDomByNativeNode(el) as VElement;
        if (!vElement) {
          return;
        }
        const selection = this.selection;
        let isNext = true;
        (this.options.hooks || []).forEach(lifecycle => {
          if (typeof lifecycle.onEnter === 'function') {
            if (lifecycle.onEnter(this.renderer, selection) === false) {
              isNext = false;
            }
          }
        })
        if (isNext) {
          this.renderer.dispatchEvent(vElement, EventType.onEnter, selection);
        }
        this.render();
        selection.restore();
        this.input.updateStateBySelection(this.nativeSelection);
        this.recordSnapshotFromEditingBefore();
        this.userWriteEvent.next();
      }
    })
    this.input.events.addKeymap({
      keymap: {
        key: 'Backspace'
      },
      action: () => {
        const focusNode = this.nativeSelection.focusNode;
        let el = focusNode.nodeType === 3 ? focusNode.parentNode : focusNode;
        const vElement = this.renderer.getVDomByNativeNode(el) as VElement;
        if (!vElement) {
          return;
        }
        const selection = this.selection;
        let isNext = true;
        (this.options.hooks || []).forEach(lifecycle => {
          if (typeof lifecycle.onDelete === 'function') {
            if (lifecycle.onDelete(this.renderer, selection) === false) {
              isNext = false;
            }
          }
        })
        if (isNext) {
          this.renderer.dispatchEvent(vElement, EventType.onDelete, selection);
        }
        if (this.rootFragment.contentLength === 0) {
          const p = new BlockTemplate('p');
          const fragment = new Fragment();
          fragment.append(new SingleTagTemplate('br'));
          p.slot = fragment;
          this.rootFragment.append(p);
          selection.firstRange.setStart(fragment, 0);
          selection.firstRange.collapse();
        }
        this.render();
        selection.restore();
        this.input.updateStateBySelection(this.nativeSelection);
        this.recordSnapshotFromEditingBefore();
        this.userWriteEvent.next();
      }
    })
    this.input.keymap({
      keymap: {
        key: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      },
      action: (ev: KeyboardEvent) => {
        const map: { [key: string]: CursorMoveDirection } = {
          ArrowLeft: CursorMoveDirection.Left,
          ArrowRight: CursorMoveDirection.Right,
          ArrowUp: CursorMoveDirection.Up,
          ArrowDown: CursorMoveDirection.Down
        };
        this.moveCursor(map[ev.key]);
      }
    });
    this.input.keymap({
      keymap: {
        key: 'a',
        ctrlKey: true
      },
      action: () => {
        this.selectAll();
      }
    });

    this.tasks.forEach(fn => fn());
    this.recordSnapshot();
  }

  private selectAll() {
    const selection = this.selection;
    const firstRange = selection.firstRange;
    const firstPosition = firstRange.findFirstPosition(this.rootFragment);
    const lastPosition = firstRange.findLastChild(this.rootFragment);
    selection.removeAllRanges();

    firstRange.setStart(firstPosition.fragment, firstPosition.index);
    firstRange.setEnd(lastPosition.fragment, lastPosition.index);

    selection.addRange(firstRange);
    selection.restore();
  }

  private paste(contents: Contents) {
    const firstRange = this.selection.firstRange;
    const fragment = firstRange.startFragment;

    const parentTemplate = this.renderer.getParentTemplateByFragment(fragment);

    if (parentTemplate instanceof BackboneTemplate) {
      let i = 0
      contents.slice(0).forEach(item => {
        fragment.insert(item, firstRange.startIndex + i);
        i += item.length;
      });
      firstRange.startIndex = firstRange.endIndex = firstRange.startIndex + i;
    } else {
      const firstChild = fragment.getContentAtIndex(0);
      const parentFragment = this.renderer.getParentFragmentByTemplate(parentTemplate);
      const contentsArr = contents.slice(0);
      if (fragment.contentLength === 0 || fragment.contentLength === 1 && firstChild instanceof SingleTagTemplate && firstChild.tagName === 'br') {
        contentsArr.forEach(item => parentFragment.insertBefore(item, parentTemplate));
      } else {
        const firstContent = contentsArr.shift();
        if (firstContent instanceof BackboneTemplate) {
          parentFragment.insertAfter(firstContent, parentTemplate);
        } else if (firstContent instanceof BranchTemplate) {
          const length = firstContent.slot.contentLength;
          const firstContents = firstContent.slot.delete(0);
          firstContents.contents.reverse().forEach(c => fragment.insert(c, firstRange.startIndex));
          firstContents.formatRanges.forEach(f => {
            if (f.renderer instanceof InlineFormatter) {
              fragment.apply({
                ...f,
                startIndex: f.startIndex + firstRange.startIndex,
                endIndex: f.endIndex + firstRange.startIndex
              })
            }
          })
          if (contentsArr.length === 0) {
            firstRange.startIndex = firstRange.endIndex = firstRange.startIndex + length;
          } else {
            const afterContents = fragment.delete(firstRange.startIndex);
            contentsArr.reverse().forEach(c => parentFragment.insertAfter(c, parentTemplate));
            const afterTemplate = parentTemplate.clone() as BranchTemplate;
            afterTemplate.slot = new Fragment();
            afterContents.contents.forEach(c => afterTemplate.slot.append(c));
            afterContents.formatRanges.forEach(f => {
              afterTemplate.slot.apply({
                ...f,
                startIndex: 0,
                endIndex: f.endIndex - f.startIndex
              });
            });
            if (afterTemplate.slot.contentLength === 0) {
              afterTemplate.slot.append(new SingleTagTemplate('br'));
            }
            firstRange.setStart(afterTemplate.slot, 0);
            firstRange.collapse();
          }
        }
      }
    }


    this.render();
    this.viewer.updateFrameHeight();
    this.selection.restore();
    this.invokeViewUpdatedHooks();
  }

  /**
   * 记录编辑前的快照
   */
  private recordSnapshotFromEditingBefore(keepInputStatus = false) {
    if (!keepInputStatus) {
      this.input.cleanValue();
    }
    this.selectionSnapshot = this.selection.clone();
    this.fragmentSnapshot = this.selectionSnapshot.commonAncestorFragment.clone();
  }

  private apply(config: ToolConfig, commander: Commander) {
    const selection = this.selection;
    const state = config.matcher ?
      config.matcher.queryState(selection, this.renderer, this).state :
      HighlightState.Normal;
    if (state === HighlightState.Disabled) {
      return;
    }
    const overlap = state === HighlightState.Highlight;
    let isNext = true;
    (this.options.hooks || []).forEach(lifecycle => {
      if (typeof lifecycle.onApplyCommand === 'function' &&
        lifecycle.onApplyCommand(commander, selection, this) === false) {
        isNext = false;
      }
    })
    if (isNext) {
      commander.command(selection, overlap, this.renderer, this.rootFragment);
      this.render();
      selection.restore();
      this.toolbar.updateHandlerState(selection, this.renderer);
    }
  }

  private render() {
    const rootFragment = this.rootFragment;
    Editor.guardLastIsParagraph(rootFragment);
    this.renderer.render(rootFragment, this.viewer.contentDocument.body).events.subscribe(event => {
      if (event.type === EventType.onDelete) {
        this.selection.ranges.forEach(range => {
          if (!range.collapsed) {
            range.connect();
            return;
          }
          let prevPosition = range.getPreviousPosition();
          if (range.startIndex > 0) {

            const commonAncestorFragment = range.commonAncestorFragment;
            const c = commonAncestorFragment.getContentAtIndex(prevPosition.index - 1);
            if (typeof c === 'string' || c instanceof LeafTemplate) {
              commonAncestorFragment.delete(range.startIndex - 1, 1);
              range.startIndex = range.endIndex = range.startIndex - 1;
            } else if (prevPosition.index === 0 && prevPosition.fragment === commonAncestorFragment) {
              commonAncestorFragment.delete(range.startIndex - 1, 1);
              range.startIndex = range.endIndex = range.startIndex - 1;
              if (commonAncestorFragment.contentLength === 0) {
                commonAncestorFragment.append(new SingleTagTemplate('br'));
              }
            } else {
              while (prevPosition.fragment.contentLength === 0) {
                range.deleteEmptyTree(prevPosition.fragment);
                prevPosition = range.getPreviousPosition();
              }
              range.setStart(prevPosition.fragment, prevPosition.index);
              range.connect();
            }
          } else {
            while (prevPosition.fragment.contentLength === 0) {
              range.deleteEmptyTree(prevPosition.fragment);
              let position = range.getPreviousPosition();
              if (prevPosition.fragment === position.fragment && prevPosition.index === position.index) {
                position = range.getNextPosition();
                break;
              }
              prevPosition = position;
            }

            const firstContent = range.startFragment.getContentAtIndex(0);
            if (firstContent instanceof SingleTagTemplate && firstContent.tagName === 'br') {
              range.startFragment.delete(0, 1);
              if (range.startFragment.contentLength === 0) {
                range.deleteEmptyTree(range.startFragment);
                const prevContent = prevPosition.fragment.getContentAtIndex(prevPosition.fragment.contentLength - 1);
                if (prevContent instanceof SingleTagTemplate && prevContent.tagName === 'br') {
                  prevPosition.index--;
                }

                range.setStart(prevPosition.fragment, prevPosition.index);
                range.collapse();
              }
            } else {
              range.setStart(prevPosition.fragment, prevPosition.index);
              range.connect();
            }
            while (prevPosition.fragment.contentLength === 0) {
              const position = range.getNextPosition();
              if (position.fragment === prevPosition.fragment && position.index === prevPosition.index) {
                break;
              }
              range.deleteEmptyTree(prevPosition.fragment);
              range.setStart(position.fragment, position.index);
              range.collapse();
              prevPosition = position;
            }
          }
        });
      } else if (event.type === EventType.onEnter) {
        const firstRange = event.selection.firstRange;
        rootFragment.insert(new SingleTagTemplate('br'), firstRange.startIndex);
        firstRange.startIndex = firstRange.endIndex = firstRange.startIndex + 1;
        const afterContent = rootFragment.sliceContents(firstRange.startIndex, firstRange.startIndex + 1)[0];
        if (typeof afterContent === 'string' || afterContent instanceof LeafTemplate) {
          return;
        }
        rootFragment.insert(new SingleTagTemplate('br'), firstRange.startIndex);
      }
    });

    this.viewer.updateFrameHeight();
    this.invokeViewUpdatedHooks();
  }

  private invokeViewUpdatedHooks() {
    (this.options.hooks || []).forEach(lifecycle => {
      if (typeof lifecycle.onViewUpdated === 'function') {
        lifecycle.onViewUpdated();
      }
    })
  }

  private moveCursor(direction: CursorMoveDirection) {
    const selection = this.selection;
    selection.ranges.forEach(range => {
      let p: TBRangePosition;
      let range2: TBRange;
      switch (direction) {
        case CursorMoveDirection.Left:
          p = range.getPreviousPosition();
          break;
        case CursorMoveDirection.Right:
          p = range.getNextPosition();
          break;
        case CursorMoveDirection.Up:
          clearTimeout(this.cleanOldCursorTimer);
          range2 = range.clone().restore();

          if (this.oldCursorPosition) {
            p = range2.getPreviousLinePosition(this.oldCursorPosition.left, this.oldCursorPosition.top);
          } else {
            const rect = range2.getRangePosition();
            this.oldCursorPosition = rect;
            p = range.getPreviousLinePosition(rect.left, rect.top);
          }
          this.cleanOldCursorTimer = setTimeout(() => {
            this.oldCursorPosition = null;
          }, 3000);
          break;
        case CursorMoveDirection.Down:
          clearTimeout(this.cleanOldCursorTimer);
          range2 = range.clone().restore();

          if (this.oldCursorPosition) {
            p = range2.getNextLinePosition(this.oldCursorPosition.left, this.oldCursorPosition.top);
          } else {
            const rect = range2.getRangePosition();
            this.oldCursorPosition = rect;
            p = range.getNextLinePosition(rect.left, rect.top);
          }
          this.cleanOldCursorTimer = setTimeout(() => {
            this.oldCursorPosition = null;
          }, 3000);
          break;
      }
      range.startFragment = range.endFragment = p.fragment;
      range.startIndex = range.endIndex = p.index;
    });
    selection.restore();
    this.recordSnapshotFromEditingBefore();
  }

  private recordSnapshot() {
    if (this.historySequence.length !== this.historyIndex) {
      this.historySequence.length = this.historyIndex + 1;
    }
    this.historySequence.push({
      contents: this.rootFragment.clone(),
      paths: this.selection ? this.selection.getRangePaths() : []
    });
    if (this.historySequence.length > this.historyStackSize) {
      this.historySequence.shift();
    }
    this.historyIndex = this.historySequence.length - 1;
    this.dispatchContentChangeEvent();
  }

  private run(fn: () => void) {
    if (!this.readyState) {
      this.tasks.push(fn);
      return;
    }
    fn();
  }

  private writeContents(html: string) {
    return new Promise<HTMLElement>(resolve => {
      const temporaryIframe = document.createElement('iframe');
      temporaryIframe.onload = () => {
        const body = temporaryIframe.contentDocument.body;
        document.body.removeChild(temporaryIframe);
        resolve(body);
      };
      temporaryIframe.style.cssText =
        'position: absolute;' +
        'left: -9999px;' +
        'top: -9999px;' +
        'width:0;' +
        'height:0;' +
        'opacity:0';
      temporaryIframe.src = `javascript:void((function () {
                      document.open();
                      document.write('${html.replace(/[']/g, '\\\'')}');
                      document.close();
                    })())`;

      document.body.appendChild(temporaryIframe);
    });
  }

  private dispatchContentChangeEvent() {
    this.changeEvent.next();
  }

  private listenUserWriteEvent() {
    if (this.sub) {
      this.sub.unsubscribe();
    }
    this.sub = this.onUserWrite.pipe(tap(() => {
      this.dispatchContentChangeEvent();
    })).pipe(sampleTime(5000)).subscribe(() => {
      this.recordSnapshot();
      this.toolbar.updateHandlerState(this.selection, this.renderer);
    });
  }

  private static cloneHistoryData(snapshot: Snapshot): Snapshot {
    return {
      contents: snapshot.contents.clone(),
      paths: snapshot.paths.map(i => i)
    }
  }

  private static guardLastIsParagraph(fragment: Fragment) {
    const last = fragment.sliceContents(fragment.contentLength - 1)[0];
    if (last instanceof BlockTemplate) {
      if (last.tagName === 'p') {
        if (last.slot.contentLength === 0) {
          last.slot.append(new SingleTagTemplate('br'));
        }
        return;
      }
    }
    const p = new BlockTemplate('p');
    const ff = new Fragment();
    ff.append(new SingleTagTemplate('br'));
    p.slot = ff;
    fragment.append(p);
  }
}
