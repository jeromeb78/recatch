export interface Category {
  id: string;
  name: string;
  is_business: boolean;
  color: string | null;
}

export interface ReceiptFile {
  path: string;
  mime: string;
  name: string;
}

export interface Receipt {
  id: string;
  source: "gmail" | "forward" | "upload" | "extension";
  source_url?: string | null;
  status: "ready" | "needs_review";
  review_reasons: string[];
  document_type: string;
  merchant: string | null;
  order_number: string | null;
  purchase_date: string | null;
  currency: string;
  subtotal: number | null;
  tax: number | null;
  shipping: number | null;
  discount: number | null;
  total: number | null;
  payment_method: string | null;
  category_id: string | null;
  notes: string | null;
  confidence: number | null;
  email_subject: string | null;
  email_from: string | null;
  files: ReceiptFile[];
  created_at: string;
}

export interface LineItem {
  id: string;
  receipt_id: string;
  position: number;
  description: string;
  store_sku: string | null;
  quantity: number;
  unit_price: number | null;
  total: number | null;
  category_id: string | null;
  woo_sku: string | null;
  pack_size: number;
  tax_line: string | null;
  use_type: "business" | "personal" | "mixed" | null;
  tax_confidence: number | null;
}

export interface Connection {
  id: string;
  email: string;
  status: "active" | "error" | "revoked";
  last_error: string | null;
  sync_from: string;
  last_synced_at: string | null;
}
