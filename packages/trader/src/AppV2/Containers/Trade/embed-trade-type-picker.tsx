import React from 'react';
import clsx from 'clsx';

import Guide from 'AppV2/Components/Guide';
import { getTradeTypesList } from 'AppV2/Utils/trade-types-utils';

/** True when the core embed bridge marked the page as framed by an allow-listed parent site. */
export const isEmbeddedLayout = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dt-embedded');

type TEmbedTradeTypePickerProps = {
    contract_type: string;
    trade_types: ReturnType<typeof getTradeTypesList>;
    onSelect: (value: string) => void;
};

/**
 * Compact trade-type control used inside a parent site: the parent owns navigation, so instead of
 * the chip row in the page header the current trade type sits as a card at the top of the
 * parameters column, with the "learn about this trade type" link above it.
 */
const EmbedTradeTypePicker = ({ contract_type, trade_types, onSelect }: TEmbedTradeTypePickerProps) => {
    const [is_open, setIsOpen] = React.useState(false);
    const ref = React.useRef<HTMLDivElement>(null);

    const current = trade_types.find(({ value }) => value === contract_type);
    // De-duplicate by label (e.g. the two Vanillas sides share one entry).
    const options = trade_types.filter((t, i, list) => list.findIndex(o => o.text === t.text) === i);

    React.useEffect(() => {
        if (!is_open) return undefined;
        const close = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
        };
        const esc = (e: KeyboardEvent) => e.key === 'Escape' && setIsOpen(false);
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', esc);
        };
    }, [is_open]);

    return (
        <div className='embed-trade-type' ref={ref}>
            <div className='embed-trade-type__guide'>
                <Guide show_guide_for_selected_contract />
            </div>
            <button
                type='button'
                className={clsx('embed-trade-type__current', { 'embed-trade-type__current--open': is_open })}
                aria-haspopup='listbox'
                aria-expanded={is_open}
                onClick={() => setIsOpen(open => !open)}
            >
                <span className='embed-trade-type__chevron' aria-hidden='true'>
                    ‹
                </span>
                <span className='embed-trade-type__name'>{current?.text ?? contract_type}</span>
            </button>
            {is_open && (
                <ul className='embed-trade-type__list' role='listbox'>
                    {options.map(({ text, value }) => (
                        <li key={value}>
                            <button
                                type='button'
                                role='option'
                                aria-selected={text === current?.text}
                                className={clsx('embed-trade-type__option', {
                                    'embed-trade-type__option--active': text === current?.text,
                                })}
                                onClick={() => {
                                    setIsOpen(false);
                                    if (value !== contract_type) onSelect(value);
                                }}
                            >
                                {text}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default EmbedTradeTypePicker;
