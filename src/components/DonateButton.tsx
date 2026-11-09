import { useRef, useState } from "react";

/** Path of the donate QR image in /public. Drop your real QR there (replace this file). */
const QR_SRC = "/donate-qr.png";
const ACCOUNT_NO = "1903 9767 5810 11";

/** Header button → modal with donate QR to help pay for server costs. */
export function DonateButton() {
  const ref = useRef<HTMLDialogElement>(null);
  const [qrMissing, setQrMissing] = useState(false);

  return (
    <>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => ref.current?.showModal()}>
        ♥ Ủng hộ
      </button>
      <dialog
        ref={ref}
        className="donate"
        aria-labelledby="donate-title"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close(); // backdrop click
        }}
      >
        <h2 id="donate-title" className="donate__title">Ủng hộ RomLingo</h2>
        <p className="donate__text">
          RomLingo là miễn phí. Nếu bạn thấy hữu ích, có thể quét mã QR để hỗ trợ duy trì server &amp; chi phí AI. Cảm ơn bạn nhiềuu!
        </p>
        {qrMissing ? (
          <div className="donate__qr donate__qr--empty">
            Chưa có mã QR.
            <br />
            Thêm ảnh vào <code>public/donate-qr.png</code>
          </div>
        ) : (
          <img className="donate__qr" src={QR_SRC} alt="Mã QR nhận ủng hộ" onError={() => setQrMissing(true)} />
        )}
        <p className="donate__text donate__bank">
          Techcombank · <strong>PHAN TIEN HUY</strong>
          <br />
          <span className="donate__acc">{ACCOUNT_NO}</span>
        </p>
        <button type="button" className="btn btn--sm" onClick={() => ref.current?.close()}>
          Đóng
        </button>
      </dialog>
    </>
  );
}
