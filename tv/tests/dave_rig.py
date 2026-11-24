"""Build a real two-member DAVE group in-process (we play Discord's external sender) so we can test
libdave's H.264 encryptor with real frames."""
import struct, dave
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization

def varint(n):
    if n < 64: return bytes([n])
    if n < 16384: return struct.pack('>H', 0x4000 | n)
    return struct.pack('>I', 0x80000000 | n)
def vec(b): return varint(len(b)) + b

def make_group(channel_id=123456789012345678, epoch=0, verbose=True):
    sk = ec.generate_private_key(ec.SECP256R1())
    pub = sk.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ext_pkg = vec(pub) + struct.pack('>H', 1) + vec(b'external-sender')
    a = dave.Session(lambda r, d: print('A MLS failure', r, d))
    b = dave.Session(lambda r, d: print('B MLS failure', r, d))
    a.init(1, channel_id, '100'); b.init(1, channel_id, '200')
    a.set_external_sender(ext_pkg); b.set_external_sender(ext_pkg)
    kpa = a.get_marshalled_key_package(); kpb = b.get_marshalled_key_package()
    group_id = struct.pack('>Q', channel_id)
    def proposal_msg(kp):
        content = vec(group_id) + struct.pack('>Q', epoch) + bytes([2]) + struct.pack('>I', 0) + vec(b'') + bytes([2]) + struct.pack('>H', 1) + kp
        tbs = struct.pack('>HH', 1, 1) + content
        signed = vec(b'MLS 1.0 FramedContentTBS') + vec(tbs[4:])
        # SignContent is over FramedContentTBS = version||wire_format||FramedContent
        signed = vec(b'MLS 1.0 FramedContentTBS') + vec(tbs)
        sig = sk.sign(signed, ec.ECDSA(hashes.SHA256()))
        return struct.pack('>HH', 1, 1) + content + vec(sig)
    # Discord sends adds for every member; A is the pending-group creator and commits them.
    proposals = bytes([0]) + vec(proposal_msg(kpb))
    recognized = {'100', '200'}
    out = a.process_proposals(proposals, recognized)
    if verbose: print('process_proposals ->', None if out is None else len(out))
    return a, b, out, recognized

def establish():
    a, b, out, rec = make_group(verbose=False)
    assert out, 'no commit produced'
    # out = commit || welcome. Welcome is an MLSMessage: 00 01 00 03 (mls10, welcome).
    import re
    last = None
    for i in range(40, len(out) - 10):
        if out[i:i+2] != b'\x00\x02':
            continue
        try:
            r = b.process_welcome(out[i:], rec)
        except Exception as e:
            last = e; continue
        if r is not None:
            try: a.process_commit(out[:i])
            except Exception as e: print('A.process_commit:', e)
            return a, b
    raise RuntimeError(f'welcome not accepted: {last} ')

def encryptor_for(session, user_id, ssrc=701):
    e = dave.Encryptor()
    e.assign_ssrc_to_codec(ssrc, dave.Codec.h264)
    e.set_key_ratchet(session.get_key_ratchet(user_id))
    e.set_passthrough_mode(False)
    return e
