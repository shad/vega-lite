import {Channel, COLOR, COLUMN, OPACITY, ROW, SCALE_CHANNELS, ScaleChannel, SHAPE, SIZE, X, Y} from '../../channel';
import {Config} from '../../config';
import * as log from '../../log';
import {Mark} from '../../mark';
import {channelScalePropertyIncompatability, isExtendedScheme, Range, Scale, ScaleConfig, ScaleType, scaleTypeSupportProperty, Scheme} from '../../scale';
import {Type} from '../../type';
import * as util from '../../util';
import {isVgRangeStep, VgRange, VgRangeScheme} from '../../vega.schema';
import {Model} from '../model';
import {Explicit, makeImplicit, Split} from '../split';
import {UnitModel} from '../unit';
import {ScaleComponent, ScaleComponentIndex} from './component';
import {parseNonUnitScaleProperty} from './properties';


export type RangeMixins = {range: Range} | {rangeStep: number} | {scheme: Scheme};

export const RANGE_PROPERTIES: (keyof Scale)[] = ['range', 'rangeStep', 'scheme'];


export function parseScaleRange(model: Model) {
  if (model instanceof UnitModel) {
    parseUnitScaleRange(model);
  } else {
    parseNonUnitScaleProperty(model, 'range');
  }
}

function parseUnitScaleRange(model: UnitModel) {
  const  localScaleComponents: ScaleComponentIndex = model.component.scales;

  // use SCALE_CHANNELS instead of scales[channel] to ensure that x, y come first!
  SCALE_CHANNELS.forEach((channel: ScaleChannel) => {
    const localScaleCmpt = localScaleComponents[channel];
    if (!localScaleCmpt) {
      return;
    }

    const specifiedScale = model.specifiedScales[channel];
    const fieldDef = model.fieldDef(channel);

    // Read if there is a specified width/height
    const specifiedSize = channel === 'x' ? model.component.layoutSize.get('width') :
      channel === 'y' ? model.component.layoutSize.get('height') : undefined;

    const xyRangeSteps = getXYRangeStep(model);

    const rangeWithExplicit = parseRangeForChannel(
      channel, localScaleCmpt.get('type'), fieldDef.type, specifiedScale, model.config,  localScaleCmpt.get('zero'), model.mark(), specifiedSize, xyRangeSteps);

    localScaleCmpt.setWithExplicit('range', rangeWithExplicit);
  });
}

function getXYRangeStep(model: UnitModel) {
  const xyRangeSteps = [];

  const xScale = model.getScaleComponent('x');
  const xRange = xScale && xScale.get('range');
  if (xRange && isVgRangeStep(xRange)) {
    xyRangeSteps.push(xRange.step);
  }

  const yScale = model.getScaleComponent('y');
  const yRange = yScale && yScale.get('range');
  if (yRange && isVgRangeStep(yRange)) {
    xyRangeSteps.push(yRange.step);
  }

  return xyRangeSteps;
}

/**
 * Return mixins that includes one of the range properties (range, rangeStep, scheme).
 */
export function parseRangeForChannel(
    channel: Channel, scaleType: ScaleType, type: Type, specifiedScale: Scale, config: Config,
    zero: boolean, mark: Mark, specifiedSize: number | undefined, xyRangeSteps: number[]
  ): Explicit<VgRange> {

  let specifiedRangeStepIsNull = false;

  // Check if any of the range properties is specified.
  // If so, check if it is compatible and make sure that we only output one of the properties
  for (const property of RANGE_PROPERTIES) {
    if (specifiedScale[property] !== undefined) {
      const supportedByScaleType = scaleTypeSupportProperty(scaleType, property);
      const channelIncompatability = channelScalePropertyIncompatability(channel, property);
      if (!supportedByScaleType) {
        log.warn(log.message.scalePropertyNotWorkWithScaleType(scaleType, property, channel));
      } else if (channelIncompatability) { // channel
        log.warn(channelIncompatability);
      } else {
        switch (property) {
          case 'range':
            return makeImplicit(specifiedScale[property]);
          case 'scheme':
            return makeImplicit(parseScheme(specifiedScale[property]));
          case 'rangeStep':
            if (specifiedSize === undefined) {
              const rangeStep = specifiedScale[property];
              if (rangeStep !== null) {
                return makeImplicit({step: rangeStep});
              } else {
                specifiedRangeStepIsNull = true;
              }
            } else {
              // If top-level size is specified, we ignore specified rangeStep.
              log.warn(log.message.rangeStepDropped(channel));
            }
        }
      }
    }
  }
  return {
    explicit: false,
    value: defaultRange(channel, scaleType, type, config, zero, mark, specifiedSize, xyRangeSteps, specifiedRangeStepIsNull)
  };
}

function parseScheme(scheme: Scheme) {
  if (isExtendedScheme(scheme)) {
    const r: VgRangeScheme = {scheme: scheme.name};
    if (scheme.count) {
      r.count = scheme.count;
    }
    if (scheme.extent) {
      r.extent = scheme.extent;
    }
    return r;
  }
  return {scheme: scheme};
}

export function defaultRange(channel: Channel, scaleType: ScaleType, type: Type, config: Config,
  zero: boolean, mark: Mark, topLevelSize: number | undefined, xyRangeSteps: number[],
  specifiedRangeStepIsNull: boolean): VgRange {
  switch (channel) {
    // TODO: revise row/column when facetSpec has top-level width/height
    case ROW:
      return 'height';
    case COLUMN:
      return 'width';
    case X:
    case Y:
      if (topLevelSize === undefined) {
        if (util.contains(['point', 'band'], scaleType) && !specifiedRangeStepIsNull) {
          if (channel === X && mark === 'text') {
            if (config.scale.textXRangeStep) {
              return {step: config.scale.textXRangeStep};
            }
          } else {
            if (config.scale.rangeStep) {
              return {step: config.scale.rangeStep};
            }
          }
        }
        // If specified range step is null or the range step config is null.
        // Use default topLevelSize rule/config
        topLevelSize = channel === X ? config.cell.width : config.cell.height;
      }
      return channel === X ? [0, topLevelSize] : [topLevelSize, 0];

    case SIZE:
      // TODO: support custom rangeMin, rangeMax
      const rangeMin = sizeRangeMin(mark, zero, config);
      const rangeMax = sizeRangeMax(mark, xyRangeSteps, config);
      return [rangeMin, rangeMax];
    case SHAPE:
      return 'symbol';
    case COLOR:
      if (scaleType === 'ordinal') {
        // Only nominal data uses ordinal scale by default
        return type === 'nominal' ? 'category' : 'ordinal';
      }
      return mark === 'rect' ? 'heatmap' : 'ramp';
    case OPACITY:
      // TODO: support custom rangeMin, rangeMax
      return [config.scale.minOpacity, config.scale.maxOpacity];
  }
  /* istanbul ignore next: should never reach here */
  throw new Error(`Scale range undefined for channel ${channel}`);
}

function sizeRangeMin(mark: Mark, zero: boolean, config: Config) {
  if (zero) {
    return 0;
  }
  switch (mark) {
    case 'bar':
      return config.scale.minBandSize !== undefined ? config.scale.minBandSize : config.bar.continuousBandSize;
    case 'tick':
      return config.scale.minBandSize;
    case 'line':
    case 'rule':
      return config.scale.minStrokeWidth;
    case 'text':
      return config.scale.minFontSize;
    case 'point':
    case 'square':
    case 'circle':
      if (config.scale.minSize) {
        return config.scale.minSize;
      }
  }
  /* istanbul ignore next: should never reach here */
  // sizeRangeMin not implemented for the mark
  throw new Error(log.message.incompatibleChannel('size', mark));
}

function sizeRangeMax(mark: Mark, xyRangeSteps: number[], config: Config) {
  const scaleConfig = config.scale;
  // TODO(#1168): make max size scale based on rangeStep / overall plot size
  switch (mark) {
    case 'bar':
    case 'tick':
      if (config.scale.maxBandSize !== undefined) {
        return config.scale.maxBandSize;
      }
      return minXYRangeStep(xyRangeSteps, config.scale) - 1;
    case 'line':
    case 'rule':
      return config.scale.maxStrokeWidth;
    case 'text':
      return config.scale.maxFontSize;
    case 'point':
    case 'square':
    case 'circle':
      if (config.scale.maxSize) {
        return config.scale.maxSize;
      }

      // FIXME this case totally should be refactored
      const pointStep = minXYRangeStep(xyRangeSteps, scaleConfig);
      return (pointStep - 2) * (pointStep - 2);
  }
  /* istanbul ignore next: should never reach here */
  // sizeRangeMax not implemented for the mark
  throw new Error(log.message.incompatibleChannel('size', mark));
}

/**
 * @returns {number} Range step of x or y or minimum between the two if both are ordinal scale.
 */
function minXYRangeStep(xyRangeSteps: number[], scaleConfig: ScaleConfig): number {
  if (xyRangeSteps.length > 0) {
    return Math.min.apply(null, xyRangeSteps);
  }
  if (scaleConfig.rangeStep) {
    return scaleConfig.rangeStep;
  }
  return 21; // FIXME: re-evaluate the default value here.
}
