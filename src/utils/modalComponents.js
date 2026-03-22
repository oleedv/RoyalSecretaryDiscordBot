/**
 * Raw modal component helpers for Discord Components v2.
 *
 * discord.js 14.x lacks builder classes for RadioGroup (21) and CheckboxGroup (22).
 * When showModal() receives a plain object (not a ModalBuilder), it serialises
 * via jsonTransformer (camelCase -> snake_case), so we build camelCase objects.
 */

const TYPE_ACTION_ROW = 1;
const TYPE_TEXT_INPUT = 4;
const TYPE_LABEL = 18;
const TYPE_RADIO_GROUP = 21;
const TYPE_CHECKBOX_GROUP = 22;

const TEXT_STYLE_SHORT = 1;
const TEXT_STYLE_PARAGRAPH = 2;

export function rawModal(customId, title, components) {
  return { customId, title, components };
}

export function labelComponent(label, component, { description } = {}) {
  return {
    type: TYPE_LABEL,
    label,
    ...(description && { description }),
    component,
  };
}

export function textInput(customId, style = 'short', opts = {}) {
  return {
    type: TYPE_TEXT_INPUT,
    customId,
    style: style === 'paragraph' ? TEXT_STYLE_PARAGRAPH : TEXT_STYLE_SHORT,
    ...(opts.placeholder && { placeholder: opts.placeholder }),
    ...(opts.minLength !== undefined && { minLength: opts.minLength }),
    ...(opts.maxLength !== undefined && { maxLength: opts.maxLength }),
    ...(opts.required !== undefined && { required: opts.required }),
    ...(opts.value !== undefined && { value: opts.value }),
  };
}

export function radioGroup(customId, options, { required = true } = {}) {
  return {
    type: TYPE_RADIO_GROUP,
    customId,
    options,
    required,
  };
}

export function checkboxGroup(customId, options, { required = true, minValues, maxValues } = {}) {
  return {
    type: TYPE_CHECKBOX_GROUP,
    customId,
    options,
    required,
    ...(minValues !== undefined && { minValues }),
    ...(maxValues !== undefined && { maxValues }),
  };
}
