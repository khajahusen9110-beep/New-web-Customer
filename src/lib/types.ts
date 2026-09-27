// Data models mirroring the Supabase tables used by the Sndmart customer app.

export interface City {
  id: string;
  name: string;
  state?: string | null;
  status?: string;
  center_lat?: number | null;
  center_lng?: number | null;
  service_radius_km?: number | null;
}

export interface CityLocationResult {
  city_id: string;
  city_name: string;
  distance_km?: number | null;
}

export interface Category {
  id: string;
  name: string;
  image_url?: string | null;
  sort_order?: number | null;
  is_active?: boolean;
  vendor_type?: string | null;
  vendor_id?: string | null;
  city_id?: string | null;
}

export interface Vendor {
  id: string;
  name: string;
  vendor_type?: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  is_open?: boolean;
  is_active?: boolean;
  banner_url?: string | null;
  city_id?: string | null;
  opening_time?: string | null;
  closing_time?: string | null;
  is_featured?: boolean | null;
}

export interface OperatingSlot {
  id: string;
  vendor_id: string;
  start_time: string;
  end_time: string;
  is_active?: boolean;
}

export interface ProductVariantCityStock {
  price: number;
  stock_qty?: number | null;
  is_available?: boolean;
  city_id?: string | null;
}

export interface ProductVariant {
  id: string;
  label: string;
  is_active?: boolean;
  product_variant_city_stock?: ProductVariantCityStock[] | null;
}

export interface Product {
  id: string;
  category_id?: string | null;
  vendor_id?: string | null;
  name: string;
  description?: string | null;
  image_url?: string | null;
  price: number;
  mrp?: number | null;
  unit?: string | null;
  stock_qty?: number | null;
  stock_quantity?: number | null;
  is_available?: boolean;
  is_active?: boolean;
  is_featured?: boolean | null;
  available_from?: string | null;
  available_until?: string | null;
  product_variants?: ProductVariant[] | null;
}

export interface ProductCityStock {
  product_id: string;
  price?: number | null;
  mrp?: number | null;
  stock_qty?: number | null;
  is_available?: boolean | null;
}

export interface ResolvedVariant {
  id: string;
  label: string;
  price: number;
  stockQty: number;
  isAvailable: boolean;
}

/** Product with fresh city price/stock overrides applied. */
export interface ResolvedProduct {
  base: Product;
  id: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  unit?: string | null;
  vendorId?: string | null;
  isFeatured: boolean;
  isActive: boolean;
  effectivePrice: number;
  effectiveMrp?: number | null;
  effectiveStock: number;
  effectiveIsAvailable: boolean;
  variants: ResolvedVariant[];
}

export interface CartItem {
  id?: string | null;
  user_id: string;
  product_id: string;
  variant_id?: string | null;
  vendor_id?: string | null;
  city_id?: string | null;
  quantity: number;
}

export interface CartItemUi {
  cartItem: CartItem;
  product: ResolvedProduct;
  variant?: ResolvedVariant | null;
  effectivePrice: number;
  totalPrice: number;
  displayName: string;
}

export interface CustomerAddress {
  id?: string | null;
  user_id: string;
  label: string;
  recipient_name: string;
  phone: string;
  address_line: string;
  landmark?: string | null;
  lat?: number | null;
  lng?: number | null;
  city_id?: string | null;
  is_default: boolean;
}

export interface DeliverySlot {
  id: string;
  name: string;
  start_time?: string | null;
  end_time?: string | null;
  min_order_amount?: number | null;
  is_free_delivery?: boolean | null;
  delivery_fee?: number | null;
  is_active?: boolean | null;
  city_id?: string | null;
}

export interface ExpressDeliverySettings {
  city_id: string;
  is_active: boolean;
  max_delivery_minutes?: number | null;
  base_km?: number | null;
  base_charge?: number | null;
  per_km_charge_beyond?: number | null;
  free_delivery_min_order?: number | null;
  free_delivery_max_km?: number | null;
  min_order_amount?: number | null;
}

export interface CityDeliverySettings {
  city_id: string;
  free_delivery_min_order_amount?: number | null;
  handling_fee?: number | null;
}

export interface Coupon {
  id: string;
  code: string;
  description?: string | null;
  discount_type: string;
  discount_value: number;
  min_order_amount?: number | null;
  max_discount_amount?: number | null;
  usage_limit?: number | null;
  used_count?: number | null;
  starts_at?: string | null;
  expires_at?: string | null;
  is_active: boolean;
  city_id?: string | null;
}

export interface CouponValidationResult {
  isValid: boolean;
  coupon?: Coupon | null;
  discountAmount: number;
  errorMessage?: string | null;
}

export interface DeliveryPartner {
  id: string;
  name: string;
  phone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  vehicle_type?: string | null;
  vehicle_number?: string | null;
}

export interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  vendor_id?: string | null;
  delivery_partner_id?: string | null;
  address_id?: string | null;
  slot_id?: string | null;
  status: string;
  payment_method: string;
  payment_status: string;
  subtotal: number;
  discount_amount: number;
  delivery_fee: number;
  handling_fee: number;
  total_amount: number;
  city_id?: string | null;
  delivery_type?: string | null;
  placed_at?: string | null;
  created_at?: string | null;
  delivery_partners?: DeliveryPartner | null;
}

export interface OrderItem {
  id?: string;
  order_id?: string;
  product_id: string;
  product_name: string;
  variant_label?: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  vendor_id?: string | null;
}

export interface OrderStatusHistory {
  id?: string;
  order_id: string;
  status: string;
  note?: string | null;
  created_at?: string | null;
}

export interface DeliveryAssignment {
  order_id: string;
  delivery_partner_id?: string | null;
  status?: string | null;
  accepted_at?: string | null;
  estimated_delivery_minutes?: number | null;
  estimated_delivery_at?: string | null;
  delivery_otp?: string | null;
}

export interface VendorReview {
  vendor_id: string;
  customer_id: string;
  order_id?: string | null;
  rating: number;
  comment?: string | null;
  created_at?: string | null;
}

export interface DeliveryPartnerReview {
  delivery_partner_id: string;
  customer_id: string;
  order_id?: string | null;
  rating: number;
  comment?: string | null;
  created_at?: string | null;
}

export interface WalletTransaction {
  id: string;
  customer_id: string;
  order_id?: string | null;
  type: string;
  amount: number;
  reason?: string | null;
  created_at?: string | null;
}

export interface CustomerNotification {
  id: string;
  user_id?: string | null;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
  is_read: boolean;
  created_at?: string | null;
}

export interface Profile {
  id: string;
  role?: string;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  city_id?: string | null;
  current_device_session?: string | null;
}

export interface MaintenanceSettings {
  enabled: boolean;
  message?: string | null;
}

export interface RazorpayOrderResponse {
  keyId: string;
  amount: number;
  currency: string;
  razorpayOrderId: string;
}
