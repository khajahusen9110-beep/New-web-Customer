import { Navigate, useParams } from 'react-router-dom';

/** Categories now live on the Grocery page itself (round icons at the top): old links land there with the category selected. */
export default function StoreCategoryPage() {
  const { categoryId = '' } = useParams();
  return <Navigate to={categoryId ? `/stores?c=${categoryId}` : '/stores'} replace />;
}
