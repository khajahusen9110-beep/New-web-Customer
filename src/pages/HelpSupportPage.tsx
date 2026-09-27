import { useSearchParams } from 'react-router-dom';
import { ChevronRight, Mail, MessageCircle, Phone } from 'lucide-react';
import { PageHeader } from '../components/ui';

const SUPPORT_PHONE = '+919353461742';
const SUPPORT_WHATSAPP = '919110604033';
const SUPPORT_EMAIL = 'sndmartt@gmail.com';

export default function HelpSupportPage() {
  const [params] = useSearchParams();
  const orderNumber = params.get('order');
  const waText = orderNumber ? `I need help with order ${orderNumber}` : 'Hi Sndmart Support, I need help';
  const subject = orderNumber ? `Help with Order ${orderNumber}` : 'Sndmart Support';

  const options = [
    { Icon: Phone, cls: 'bg-sky text-primary', title: 'Call Support', sub: SUPPORT_PHONE, href: `tel:${SUPPORT_PHONE}` },
    {
      Icon: MessageCircle,
      cls: 'bg-sage text-success',
      title: 'WhatsApp Support',
      sub: 'Chat with us instantly',
      href: `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(waText)}`,
      external: true,
    },
    {
      Icon: Mail,
      cls: 'bg-sand text-primary',
      title: 'Email Support',
      sub: SUPPORT_EMAIL,
      href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`,
    },
  ];

  return (
    <div className="page">
      <PageHeader title="Help & Support" />
      <div className="content-pad narrow stack">
        <h2>How can we help you?</h2>
        {orderNumber && <p className="muted small">We've pre-filled your order number ({orderNumber}) for faster support.</p>}
        {options.map(({ Icon, cls, title, sub, href, external }) => (
          <a
            key={title}
            className="list-card"
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer' : undefined}
          >
            <span className={`icon-circle ${cls}`}>
              <Icon size={22} />
            </span>
            <span className="grow">
              <strong className="block">{title}</strong>
              <span className="muted small">{sub}</span>
            </span>
            <ChevronRight size={20} className="muted" />
          </a>
        ))}
        <p className="muted small center">Our support team is available 9 AM – 9 PM, all days.</p>
      </div>
    </div>
  );
}
