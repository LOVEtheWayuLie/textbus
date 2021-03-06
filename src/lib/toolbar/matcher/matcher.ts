import { Injector } from '@tanbo/di';

import {
  TBSelection,
  FormatAbstractData,
  TBRange,
  FormatEffect,
  AbstractComponent
} from '../../core/_api';
import { HighlightState } from '../help';

/**
 * 匹配到的抽象数据及状态
 */
export interface FormatMatchData {
  effect: FormatEffect;
  srcData: FormatAbstractData;
}

/**
 * 一个 Range 匹配出的结果详情
 */
export interface RangeMatchState<T> {
  state: HighlightState;
  fromRange: TBRange;
  srcData: T;
}

/**
 * Selection 对象内所有 Range 匹配出的结果详情
 */
export interface SelectionMatchState<T = FormatAbstractData | AbstractComponent> {
  state: HighlightState;
  srcStates: RangeMatchState<T>[];
  matchData: T;
}

export interface Matcher {
  onInit?(injector: Injector): void;

  queryState(selection: TBSelection): SelectionMatchState;
}
